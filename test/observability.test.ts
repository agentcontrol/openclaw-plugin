import { trace } from "@opentelemetry/api";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ControlExecutionEvent } from "agent-control";
import {
  buildControlExecutionEvents,
  buildControlObservabilityIndex,
  emitControlExecutionEvents,
  resolveTraceContext,
} from "../src/observability.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("observability helpers", () => {
  it("derives observability identity in leaf evaluation order", () => {
    // Given two rendered controls with composite and leaf conditions
    const index = buildControlObservabilityIndex([
      {
        id: 1,
        name: "composite",
        control: {
          action: {
            decision: "observe",
          },
          condition: {
            and: [
              {
                selector: {
                  path: "input",
                },
                evaluator: {
                  name: "regex",
                  config: {
                    pattern: "alpha",
                  },
                },
              },
              {
                not: {
                  selector: {
                    path: "context.user.role",
                  },
                  evaluator: {
                    name: "list",
                    config: {
                      values: ["admin"],
                    },
                  },
                },
              },
            ],
          },
          enabled: true,
          execution: "server",
        },
      },
    ]);

    // When the cached observability metadata is read back
    const identity = index.get(1);

    // Then the first leaf becomes the representative identity and all leaves are tracked
    expect(identity).toEqual({
      selectorPath: "input",
      evaluatorName: "regex",
      leafCount: 2,
      allEvaluators: ["regex", "list"],
      allSelectorPaths: ["input", "context.user.role"],
    });
  });

  it("skips unrendered controls and traverses or branches", () => {
    // Given one rendered control with an or branch and one unrendered template control
    const index = buildControlObservabilityIndex([
      {
        id: 1,
        name: "or-control",
        control: {
          action: {
            decision: "observe",
          },
          condition: {
            or: [
              {
                selector: {
                  path: "input.command",
                },
                evaluator: {
                  name: "regex",
                  config: {
                    pattern: "npm",
                  },
                },
              },
              {
                selector: {
                  path: "context.user.role",
                },
                evaluator: {
                  name: "equals",
                  config: {
                    value: "admin",
                  },
                },
              },
            ],
          },
          enabled: true,
          execution: "server",
        },
      },
      {
        id: 2,
        name: "template-control",
        control: {
          action: {
            decision: "observe",
          },
        } as never,
      },
    ]);

    // When the index is built from the returned controls
    const identity = index.get(1);

    // Then only rendered controls are indexed and both or leaves are captured
    expect(index.size).toBe(1);
    expect(identity).toEqual({
      selectorPath: "input.command",
      evaluatorName: "regex",
      leafCount: 2,
      allEvaluators: ["regex", "equals"],
      allSelectorPaths: ["input.command", "context.user.role"],
    });
  });

  it("builds control execution events with category-specific error handling", () => {
    // Given a cached control identity and a mixed evaluation response
    const events = buildControlExecutionEvents({
      evaluation: {
        isSafe: false,
        confidence: 0.5,
        matches: [
          {
            action: "deny",
            controlExecutionId: "exec-match",
            controlId: 1,
            controlName: "deny-shell",
            result: {
              matched: true,
              confidence: 0.9,
              metadata: {
                outcome: "match",
              },
            },
          },
        ],
        errors: [
          {
            action: "observe",
            controlExecutionId: "exec-error",
            controlId: 2,
            controlName: "audit-shell",
            result: {
              matched: false,
              confidence: 0.1,
              error: "timeout",
            },
          },
        ],
        nonMatches: [
          {
            action: "observe",
            controlExecutionId: "exec-non-match",
            controlId: 3,
            controlName: "allow-shell",
            result: {
              matched: false,
              confidence: 0.2,
              error: "ignored",
            },
          },
        ],
      },
      agentName: "openclaw-agent:worker-1",
      stepName: "shell",
      stepType: "tool",
      checkStage: "pre",
      traceContext: {
        traceId: "a".repeat(32),
        spanId: "b".repeat(16),
      },
      controlObservabilityById: new Map([
        [
          1,
          {
            selectorPath: "input.command",
            evaluatorName: "regex",
            leafCount: 1,
            allEvaluators: ["regex"],
            allSelectorPaths: ["input.command"],
          },
        ],
      ]),
      sourceAgentId: "worker-1",
      pluginId: "agent-control-openclaw-plugin",
      runId: "run-1",
      toolCallId: "call-1",
    });

    // When the events are built
    const [matchEvent, errorEvent, nonMatchEvent] = events;

    // Then each category maps to the correct matched/error fields
    expect(matchEvent).toMatchObject({
      matched: true,
      errorMessage: null,
      evaluatorName: "regex",
      selectorPath: "input.command",
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
    });
    expect(matchEvent.metadata).toMatchObject({
      outcome: "match",
      primary_evaluator: "regex",
      openclaw_step_name: "shell",
      openclaw_tool_call_id: "call-1",
    });

    expect(errorEvent).toMatchObject({
      matched: false,
      errorMessage: "timeout",
      evaluatorName: null,
      selectorPath: null,
    });
    expect(nonMatchEvent).toMatchObject({
      matched: false,
      errorMessage: null,
    });
  });

  it("falls back to generated trace identifiers when no active span exists", () => {
    // Given no active OpenTelemetry span
    const traceContext = resolveTraceContext();

    // When trace context is resolved
    expect(traceContext.traceId).toMatch(/^[a-f0-9]{32}$/);
    expect(traceContext.spanId).toMatch(/^[a-f0-9]{16}$/);
  });

  it("reuses the active OpenTelemetry span context when it is valid", () => {
    // Given a valid active span context from OpenTelemetry
    vi.spyOn(trace, "getActiveSpan").mockReturnValue({
      spanContext: () => ({
        traceId: "1".repeat(32),
        spanId: "2".repeat(16),
        traceFlags: 1,
      }),
    } as never);
    vi.spyOn(trace, "isSpanContextValid").mockReturnValue(true);

    // When trace context is resolved
    const traceContext = resolveTraceContext();

    // Then the active span identifiers are preserved
    expect(traceContext).toEqual({
      traceId: "1".repeat(32),
      spanId: "2".repeat(16),
    });
  });

  it("logs ingestion failures without throwing", async () => {
    // Given one event and an ingest client that fails
    const logger = {
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      block: vi.fn(),
    };
    const ingestEvents = vi.fn().mockRejectedValue(new Error("boom"));
    const events: ControlExecutionEvent[] = [
      {
        action: "observe",
        agentName: "openclaw-agent:worker-1",
        appliesTo: "tool_call",
        checkStage: "pre",
        confidence: 1,
        controlId: 1,
        controlName: "allow-shell",
        matched: false,
        spanId: "b".repeat(16),
        traceId: "a".repeat(32),
      },
    ];

    // When the fire-and-forget ingest path runs
    emitControlExecutionEvents({
      client: {
        observability: {
          ingestEvents,
        },
      } as never,
      logger,
      events,
      agentName: "openclaw-agent:worker-1",
      stepName: "shell",
    });
    await Promise.resolve();
    await Promise.resolve();

    // Then the error is logged and the caller is not forced to await or catch
    expect(ingestEvents).toHaveBeenCalledWith({ events });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("observability_ingest failed"),
    );
  });

  it("returns early when there are no events to ingest", () => {
    // Given an empty event batch
    const logger = {
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      block: vi.fn(),
    };
    const ingestEvents = vi.fn();

    // When the fire-and-forget ingest path runs
    emitControlExecutionEvents({
      client: {
        observability: {
          ingestEvents,
        },
      } as never,
      logger,
      events: [],
      agentName: "openclaw-agent:worker-1",
      stepName: "shell",
    });

    // Then no ingest call or log is emitted
    expect(ingestEvents).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.debug).not.toHaveBeenCalled();
  });

  it("warns when observability ingestion only partially enqueues events", async () => {
    // Given one event and an ingest client that partially accepts the batch
    const logger = {
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      block: vi.fn(),
    };
    const events: ControlExecutionEvent[] = [
      {
        action: "observe",
        agentName: "openclaw-agent:worker-1",
        appliesTo: "tool_call",
        checkStage: "pre",
        confidence: 1,
        controlId: 1,
        controlName: "allow-shell",
        matched: false,
        spanId: "b".repeat(16),
        traceId: "a".repeat(32),
      },
    ];
    const ingestEvents = vi.fn().mockResolvedValue({
      received: 1,
      enqueued: 0,
      dropped: 1,
      status: "partial",
    });

    // When the fire-and-forget ingest path runs
    emitControlExecutionEvents({
      client: {
        observability: {
          ingestEvents,
        },
      } as never,
      logger,
      events,
      agentName: "openclaw-agent:worker-1",
      stepName: "shell",
    });
    await Promise.resolve();
    await Promise.resolve();

    // Then the partial enqueue result is warned instead of logged as success
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("observability_ingest partial"),
    );
    expect(logger.debug).not.toHaveBeenCalled();
  });
});
