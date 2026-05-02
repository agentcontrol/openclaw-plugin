import type {
  OpenClawBeforeToolCallContext,
  OpenClawBeforeToolCallEvent,
  OpenClawPluginApi,
} from "openclaw/plugin-sdk/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { USER_BLOCK_MESSAGE } from "../src/shared.ts";

const {
  clientMocks,
  resolveStepsForContextMock,
  buildEvaluationContextMock,
} = vi.hoisted(() => ({
  clientMocks: {
    init: vi.fn(),
    agentsInit: vi.fn(),
    evaluationEvaluate: vi.fn(),
    ingestEvents: vi.fn(),
  },
  resolveStepsForContextMock: vi.fn(),
  buildEvaluationContextMock: vi.fn(),
}));

vi.mock("agent-control", () => ({
  AgentControlClient: class MockAgentControlClient {
    init = clientMocks.init;
    agents = {
      init: clientMocks.agentsInit,
    };
    evaluation = {
      evaluate: clientMocks.evaluationEvaluate,
    };
    observability = {
      ingestEvents: clientMocks.ingestEvents,
    };
  },
}));

vi.mock("../src/tool-catalog.ts", () => ({
  resolveStepsForContext: resolveStepsForContextMock,
}));

vi.mock("../src/session-context.ts", () => ({
  buildEvaluationContext: buildEvaluationContextMock,
}));

import register from "../src/agent-control-plugin.ts";

type MockApi = {
  api: OpenClawPluginApi;
  handlers: Map<string, (...args: any[]) => unknown>;
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
};

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createAgentControlServerError(
  status: number,
  payload: Record<string, unknown>,
  statusText = "Server Error",
) {
  const body = JSON.stringify(payload);
  return {
    name: "AgentControlSDKDefaultError",
    message: "API error occurred",
    response$: new Response(body, {
      status,
      statusText,
      headers: { "content-type": "application/json" },
    }),
    body$: body,
  };
}

function createMockApi(pluginConfig: Record<string, unknown>): MockApi {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const info = vi.fn();
  const warn = vi.fn();

  const api: OpenClawPluginApi = {
    id: "agent-control-openclaw-plugin",
    version: "test-version",
    config: {},
    pluginConfig,
    logger: {
      info,
      warn,
    },
    on(event, handler) {
      handlers.set(event, handler as (...args: any[]) => unknown);
    },
  };

  return { api, handlers, info, warn };
}

async function runBeforeToolCall(
  api: MockApi,
  event: Partial<OpenClawBeforeToolCallEvent> = {},
  ctx: Partial<OpenClawBeforeToolCallContext> = {},
): Promise<unknown> {
  const handler = api.handlers.get("before_tool_call");
  if (!handler) {
    throw new Error("before_tool_call handler was not registered");
  }
  return handler(
    {
      toolName: "shell",
      params: { cmd: "echo hi" },
      runId: "run-1",
      toolCallId: "call-1",
      ...event,
    },
    ctx,
  );
}

async function runGatewayStart(api: MockApi): Promise<void> {
  const handler = api.handlers.get("gateway_start");
  if (!handler) {
    throw new Error("gateway_start handler was not registered");
  }
  await handler();
}

beforeEach(() => {
  clientMocks.init.mockReset();
  clientMocks.agentsInit.mockReset().mockResolvedValue(undefined);
  clientMocks.evaluationEvaluate.mockReset().mockResolvedValue({ isSafe: true });
  clientMocks.ingestEvents.mockReset().mockResolvedValue({
    received: 0,
    enqueued: 0,
    dropped: 0,
    status: "queued",
  });
  resolveStepsForContextMock.mockReset().mockResolvedValue([{ type: "tool", name: "shell" }]);
  buildEvaluationContextMock.mockReset().mockResolvedValue({ channelType: "unknown" });
});

describe("agent-control plugin logging and blocking", () => {
  it("skips initialization when the plugin is disabled", () => {
    // Given plugin configuration with the plugin explicitly disabled
    const api = createMockApi({
      enabled: false,
      serverUrl: "http://localhost:8000",
    });

    // When the plugin is registered with the OpenClaw API
    register(api.api);

    // Then no client initialization or hook registration occurs
    expect(clientMocks.init).not.toHaveBeenCalled();
    expect(api.handlers.size).toBe(0);
  });

  it("warns and skips hook registration when no server URL is configured", () => {
    // Given plugin configuration without an Agent Control server URL
    const api = createMockApi({});

    // When the plugin is registered
    register(api.api);

    // Then registration is skipped and a warning is emitted
    expect(clientMocks.init).not.toHaveBeenCalled();
    expect(api.handlers.size).toBe(0);
    expect(api.warn).toHaveBeenCalledWith(
      expect.stringContaining("disabled because serverUrl is not configured"),
    );
  });

  it("only logs the block event in warn mode for unsafe evaluations", async () => {
    // Given warn-level logging and an unsafe policy evaluation response
    const api = createMockApi({
      serverUrl: "http://localhost:8000",
    });

    clientMocks.evaluationEvaluate.mockResolvedValueOnce({
      isSafe: false,
      reason: "denied by policy",
    });

    // When the plugin evaluates a tool call
    register(api.api);
    const result = await runBeforeToolCall(api);

    // Then the tool call is blocked and only the block event is logged
    expect(result).toEqual({
      block: true,
      blockReason: USER_BLOCK_MESSAGE,
    });
    expect(api.info).not.toHaveBeenCalled();
    expect(api.warn).toHaveBeenCalledTimes(1);
    expect(api.warn.mock.calls[0]?.[0]).toContain("blocked tool=shell");
    expect(clientMocks.agentsInit).toHaveBeenCalledOnce();
    expect(clientMocks.evaluationEvaluate).toHaveBeenCalledOnce();
  });

  it("emits lifecycle logs without debug traces in info mode", async () => {
    // Given info-level logging for a plugin that can warm up and evaluate tools
    const api = createMockApi({
      serverUrl: "http://localhost:8000",
      logLevel: "info",
    });

    // When gateway warmup and one tool evaluation are executed
    register(api.api);
    await runGatewayStart(api);
    await runBeforeToolCall(api);

    // Then lifecycle logs are emitted without low-level debug traces
    const messages = api.info.mock.calls.map(([message]) => String(message));
    expect(messages.some((message) => message.includes("client_init"))).toBe(true);
    expect(messages.some((message) => message.includes("gateway_boot_warmup started"))).toBe(true);
    expect(messages.some((message) => message.includes("gateway_boot_warmup done"))).toBe(true);
    expect(messages.some((message) => message.includes("sync_agent"))).toBe(true);
    expect(messages.some((message) => message.includes("before_tool_call entered"))).toBe(false);
    expect(messages.some((message) => message.includes("evaluated agent="))).toBe(false);
  });

  it("emits verbose traces when debug log level is enabled", async () => {
    // Given debug log level enabled in plugin configuration
    const api = createMockApi({
      serverUrl: "http://localhost:8000",
      logLevel: "debug",
    });

    // When the plugin evaluates a tool call
    register(api.api);
    await runBeforeToolCall(api);

    // Then verbose debug trace messages are emitted
    const messages = api.info.mock.calls.map(([message]) => String(message));
    expect(messages.some((message) => message.includes("before_tool_call entered"))).toBe(true);
    expect(messages.some((message) => message.includes("phase=evaluate"))).toBe(true);
  });

  it("blocks the tool call before evaluation when fail-closed sync fails", async () => {
    // Given fail-closed mode and a step-resolution failure during sync
    const api = createMockApi({
      serverUrl: "http://localhost:8000",
      failClosed: true,
    });

    resolveStepsForContextMock.mockRejectedValueOnce(new Error("resolver exploded"));

    // When the plugin attempts to evaluate a tool call
    register(api.api);
    const result = await runBeforeToolCall(api);

    // Then the tool call is blocked before evaluation and failure warnings are logged
    expect(result).toEqual({
      block: true,
      blockReason: USER_BLOCK_MESSAGE,
    });
    expect(buildEvaluationContextMock).not.toHaveBeenCalled();
    expect(clientMocks.evaluationEvaluate).not.toHaveBeenCalled();
    expect(api.warn.mock.calls.map(([message]) => String(message))).toEqual(
      expect.arrayContaining([
        expect.stringContaining("unable to sync"),
        expect.stringContaining("blocked tool=shell agent=default reason=agent_sync_failed fail_closed=true"),
      ]),
    );
  });

  it("appends the source agent ID to the base agent name", async () => {
    // Given a base agent name
    const api = createMockApi({
      serverUrl: "http://localhost:8000",
      agentName: "base-agent",
    });

    // When a source agent evaluates a tool call
    register(api.api);
    await runBeforeToolCall(api, {}, { agentId: "worker-1" });

    // Then Agent Control receives the base agent name with the source suffix appended
    expect(clientMocks.agentsInit).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: expect.objectContaining({
          agentName: "base-agent:worker-1",
        }),
      }),
    );
  });

  it("reuses warmup work across repeated gateway_start events", async () => {
    // Given a plugin instance that has already started warmup once
    const api = createMockApi({
      serverUrl: "http://localhost:8000",
    });

    // When gateway_start is fired twice
    register(api.api);
    await runGatewayStart(api);
    await runGatewayStart(api);

    // Then warmup work is reused and step resolution only runs once
    expect(resolveStepsForContextMock).toHaveBeenCalledTimes(1);
    expect(resolveStepsForContextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceAgentId: "main",
      }),
    );
  });

  it("warns when gateway warmup fails and still evaluates later tool calls", async () => {
    // Given gateway warmup fails once before regular tool evaluation starts
    const api = createMockApi({
      serverUrl: "http://localhost:8000",
    });

    resolveStepsForContextMock
      .mockRejectedValueOnce(new Error("warmup exploded"))
      .mockResolvedValue([{ type: "tool", name: "shell" }]);

    // When gateway_start and a later tool evaluation are executed
    register(api.api);
    await runGatewayStart(api);
    const result = await runBeforeToolCall(api);

    // Then the warmup failure is only warned and later tool calls still evaluate
    expect(result).toBeUndefined();
    expect(api.warn).toHaveBeenCalledWith(
      expect.stringContaining("gateway_boot_warmup failed"),
    );
    expect(clientMocks.evaluationEvaluate).toHaveBeenCalledOnce();
  });

  it("waits for in-flight gateway warmup before evaluating a tool call", async () => {
    // Given gateway warmup is still running when a tool call arrives
    const api = createMockApi({
      serverUrl: "http://localhost:8000",
      logLevel: "debug",
    });
    const warmupDeferred = createDeferred<{ type: string; name: string }[]>();
    resolveStepsForContextMock
      .mockImplementationOnce(() => warmupDeferred.promise)
      .mockResolvedValue([{ type: "tool", name: "shell" }]);

    // When gateway_start begins warmup and before_tool_call fires before warmup completes
    register(api.api);
    const gatewayStartPromise = runGatewayStart(api);
    await Promise.resolve();
    const beforeToolCallPromise = runBeforeToolCall(api);
    await Promise.resolve();
    await Promise.resolve();

    // Then evaluation does not begin until the warmup promise resolves
    expect(clientMocks.evaluationEvaluate).not.toHaveBeenCalled();

    warmupDeferred.resolve([{ type: "tool", name: "shell" }]);
    await gatewayStartPromise;
    await beforeToolCallPromise;

    expect(clientMocks.evaluationEvaluate).toHaveBeenCalledOnce();
    expect(api.info).toHaveBeenCalledWith(
      expect.stringContaining("waiting_for_gateway_boot_warmup=true"),
    );
  });

  it("deduplicates concurrent syncs for the same source agent", async () => {
    // Given two concurrent tool calls sharing the same source agent and sync promise
    const api = createMockApi({
      serverUrl: "http://localhost:8000",
    });
    const syncDeferred = createDeferred<void>();
    clientMocks.agentsInit.mockImplementation(() => syncDeferred.promise);

    // When both tool calls are started before the initial sync completes
    register(api.api);

    const first = runBeforeToolCall(api);
    const second = runBeforeToolCall(api);
    await Promise.resolve();
    await Promise.resolve();

    expect(clientMocks.agentsInit).toHaveBeenCalledTimes(1);

    syncDeferred.resolve(undefined);
    await Promise.all([first, second]);

    // Then only one sync starts and both tool calls eventually evaluate
    expect(clientMocks.evaluationEvaluate).toHaveBeenCalledTimes(2);
  });

  it("resyncs immediately when steps change during an in-flight sync", async () => {
    // Given one tool call changes the step catalog while another sync is still in flight
    const api = createMockApi({
      serverUrl: "http://localhost:8000",
    });
    const syncDeferred = createDeferred<void>();
    clientMocks.agentsInit
      .mockImplementationOnce(() => syncDeferred.promise)
      .mockResolvedValueOnce(undefined);
    resolveStepsForContextMock
      .mockResolvedValueOnce([{ type: "tool", name: "shell" }])
      .mockResolvedValueOnce([
        { type: "tool", name: "shell" },
        { type: "tool", name: "grep" },
      ]);

    // When a second tool call updates the steps before the first sync completes
    register(api.api);
    const first = runBeforeToolCall(api);
    await Promise.resolve();
    await Promise.resolve();
    const second = runBeforeToolCall(api, { toolName: "grep" });
    await Promise.resolve();
    await Promise.resolve();

    expect(clientMocks.agentsInit).toHaveBeenCalledTimes(1);

    syncDeferred.resolve(undefined);
    await Promise.all([first, second]);

    // Then the plugin immediately performs a second sync using the newer step catalog
    expect(clientMocks.agentsInit).toHaveBeenCalledTimes(2);
    expect(clientMocks.agentsInit.mock.calls[1]?.[0]).toMatchObject({
      steps: [
        { type: "tool", name: "shell" },
        { type: "tool", name: "grep" },
      ],
    });
    expect(clientMocks.evaluationEvaluate).toHaveBeenCalledTimes(2);
  });

  it("skips resyncing when the step catalog has not changed", async () => {
    // Given a source agent whose step catalog is unchanged across two tool calls
    const api = createMockApi({
      serverUrl: "http://localhost:8000",
    });

    // When the plugin evaluates two tool calls back to back
    register(api.api);
    await runBeforeToolCall(api);
    await runBeforeToolCall(api);

    // Then the agent is only synced once while both evaluations still run
    expect(clientMocks.agentsInit).toHaveBeenCalledTimes(1);
    expect(clientMocks.evaluationEvaluate).toHaveBeenCalledTimes(2);
  });

  it("deduplicates deny controls in the block reason", async () => {
    // Given an unsafe evaluation response with duplicate deny controls
    const api = createMockApi({
      serverUrl: "http://localhost:8000",
    });

    clientMocks.evaluationEvaluate.mockResolvedValueOnce({
      isSafe: false,
      matches: [
        {
          action: "deny",
          controlExecutionId: "exec-alpha-1",
          controlId: 1,
          controlName: "alpha",
          result: {
            matched: true,
            confidence: 0.9,
          },
        },
        {
          action: "deny",
          controlExecutionId: "exec-alpha-2",
          controlId: 2,
          controlName: "alpha",
          result: {
            matched: true,
            confidence: 0.8,
          },
        },
        {
          action: "deny",
          controlExecutionId: "exec-beta-1",
          controlId: 3,
          controlName: "beta",
          result: {
            matched: true,
            confidence: 0.7,
          },
        },
      ],
      errors: null,
    });

    // When the tool call is evaluated and blocked
    register(api.api);
    await runBeforeToolCall(api);

    // Then the logged block reason lists each control name only once
    const message = String(api.warn.mock.calls[0]?.[0]);
    expect(message).toContain("alpha, beta");
    expect(message).not.toContain("alpha, alpha");
  });

  it("logs the generic block reason when no policy details are returned", async () => {
    // Given an unsafe evaluation response with no policy reason or deny controls
    const api = createMockApi({
      serverUrl: "http://localhost:8000",
    });

    clientMocks.evaluationEvaluate.mockResolvedValueOnce({
      isSafe: false,
      reason: "",
      matches: null,
      errors: null,
    });

    // When the tool call is evaluated and blocked
    register(api.api);
    await runBeforeToolCall(api);

    // Then the generic policy block reason is logged
    expect(api.warn).toHaveBeenCalledWith(
      expect.stringContaining("reason=[agent-control] blocked by policy evaluation"),
    );
  });

  it("emits control execution events by default when observability is not configured", async () => {
    // Given observability is left unset and the synced agent returns one rendered control
    const api = createMockApi({
      serverUrl: "http://localhost:8000",
    });

    clientMocks.agentsInit.mockResolvedValueOnce({
      controls: [
        {
          id: 7,
          name: "deny-shell",
          control: {
            action: {
              decision: "deny",
            },
            condition: {
              selector: {
                path: "input.command",
              },
              evaluator: {
                name: "regex",
                config: {
                  pattern: "rm -rf",
                },
              },
            },
            enabled: true,
            execution: "server",
          },
        },
      ],
    });
    clientMocks.evaluationEvaluate.mockResolvedValueOnce({
      isSafe: false,
      confidence: 0.5,
      matches: [
        {
          action: "deny",
          controlExecutionId: "exec-match",
          controlId: 7,
          controlName: "deny-shell",
          result: {
            matched: true,
            confidence: 0.99,
            metadata: {
              policy_source: "server",
            },
          },
        },
      ],
      errors: [
        {
          action: "observe",
          controlExecutionId: "exec-error",
          controlId: 8,
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
          controlId: 9,
          controlName: "allow-shell",
          result: {
            matched: false,
            confidence: 0.2,
          },
        },
      ],
    });

    // When the tool call is evaluated for a named source agent
    register(api.api);
    await runBeforeToolCall(api, {}, { agentId: "worker-1" });

    // Then the plugin sends one observability batch with per-control events
    expect(clientMocks.ingestEvents).toHaveBeenCalledTimes(1);
    const request = clientMocks.ingestEvents.mock.calls[0]?.[0];
    expect(request.events).toHaveLength(3);

    const [matchedEvent, errorEvent, nonMatchEvent] = request.events;
    expect(matchedEvent).toMatchObject({
      action: "deny",
      agentName: "openclaw-agent:worker-1",
      appliesTo: "tool_call",
      checkStage: "pre",
      controlExecutionId: "exec-match",
      controlId: 7,
      controlName: "deny-shell",
      evaluatorName: "regex",
      matched: true,
      selectorPath: "input.command",
    });
    expect(matchedEvent.metadata).toMatchObject({
      policy_source: "server",
      primary_evaluator: "regex",
      primary_selector_path: "input.command",
      leaf_count: 1,
      all_evaluators: ["regex"],
      all_selector_paths: ["input.command"],
      openclaw_step_name: "shell",
      openclaw_step_type: "tool",
      openclaw_source_agent_id: "worker-1",
      openclaw_plugin_id: "agent-control-openclaw-plugin",
      openclaw_run_id: "run-1",
      openclaw_tool_call_id: "call-1",
    });
    expect(matchedEvent.traceId).toMatch(/^[a-f0-9]{32}$/);
    expect(matchedEvent.spanId).toMatch(/^[a-f0-9]{16}$/);

    expect(errorEvent).toMatchObject({
      action: "observe",
      controlExecutionId: "exec-error",
      controlId: 8,
      controlName: "audit-shell",
      errorMessage: "timeout",
      matched: false,
    });
    expect(errorEvent.traceId).toBe(matchedEvent.traceId);
    expect(errorEvent.spanId).toBe(matchedEvent.spanId);

    expect(nonMatchEvent).toMatchObject({
      action: "observe",
      controlExecutionId: "exec-non-match",
      controlId: 9,
      controlName: "allow-shell",
      errorMessage: null,
      matched: false,
    });
    expect(nonMatchEvent.traceId).toBe(matchedEvent.traceId);
    expect(nonMatchEvent.spanId).toBe(matchedEvent.spanId);
  });

  it("does not fail the tool call when default observability ingestion fails", async () => {
    // Given observability is left unset but the ingest request fails
    const api = createMockApi({
      serverUrl: "http://localhost:8000",
    });

    clientMocks.evaluationEvaluate.mockResolvedValueOnce({
      isSafe: true,
      confidence: 1,
      nonMatches: [
        {
          action: "observe",
          controlExecutionId: "exec-non-match",
          controlId: 9,
          controlName: "allow-shell",
          result: {
            matched: false,
            confidence: 0.2,
          },
        },
      ],
    });
    clientMocks.ingestEvents.mockRejectedValueOnce(
      createAgentControlServerError(503, { error: "observability offline" }, "Service Unavailable"),
    );

    // When the plugin evaluates the tool call
    register(api.api);
    const result = await runBeforeToolCall(api);
    await Promise.resolve();
    await Promise.resolve();

    // Then the tool call is still allowed and the ingest failure is only logged
    expect(result).toBeUndefined();
    const warning = api.warn.mock.calls
      .map(([message]) => String(message))
      .find((message) => message.includes("observability_ingest failed"));
    expect(warning).toContain("status=503");
    expect(warning).toContain('response_body={"error":"observability offline"}');
  });

  it("does not emit control execution events when observability is explicitly disabled", async () => {
    // Given observability is explicitly disabled in plugin configuration
    const api = createMockApi({
      serverUrl: "http://localhost:8000",
      observabilityEnabled: false,
    });

    clientMocks.evaluationEvaluate.mockResolvedValueOnce({
      isSafe: true,
      confidence: 1,
      nonMatches: [
        {
          action: "observe",
          controlExecutionId: "exec-non-match",
          controlId: 9,
          controlName: "allow-shell",
          result: {
            matched: false,
            confidence: 0.2,
          },
        },
      ],
    });

    // When the plugin evaluates a tool call
    register(api.api);
    const result = await runBeforeToolCall(api);
    await Promise.resolve();
    await Promise.resolve();

    // Then the tool call still proceeds and no observability batch is sent
    expect(result).toBeUndefined();
    expect(clientMocks.ingestEvents).not.toHaveBeenCalled();
  });


  it("logs Agent Control response details when agent sync fails", async () => {
    // Given the Agent Control server rejects agent sync with an HTTP payload
    const api = createMockApi({
      serverUrl: "http://localhost:8000",
    });

    clientMocks.agentsInit.mockRejectedValueOnce(
      createAgentControlServerError(409, { detail: "agent registration conflict" }, "Conflict"),
    );

    // When the plugin attempts to sync before evaluating a tool call
    register(api.api);
    const result = await runBeforeToolCall(api);

    // Then the failure warning includes the HTTP status and response payload
    expect(result).toBeUndefined();
    const warning = api.warn.mock.calls
      .map(([message]) => String(message))
      .find((message) => message.includes("unable to sync"));
    expect(warning).toContain("status=409");
    expect(warning).toContain('response_body={"detail":"agent registration conflict"}');
    expect(clientMocks.evaluationEvaluate).not.toHaveBeenCalled();
  });

  it("allows the tool call when fail-open sync fails", async () => {
    // Given fail-open mode and a step-resolution failure before evaluation
    const api = createMockApi({
      serverUrl: "http://localhost:8000",
    });

    resolveStepsForContextMock.mockRejectedValueOnce(new Error("resolver exploded"));

    // When the plugin attempts to evaluate a tool call
    register(api.api);
    const result = await runBeforeToolCall(api);

    // Then the tool call is allowed to continue without evaluation
    expect(result).toBeUndefined();
    expect(clientMocks.evaluationEvaluate).not.toHaveBeenCalled();
    expect(api.warn).toHaveBeenCalledWith(expect.stringContaining("unable to sync"));
    expect(api.warn).not.toHaveBeenCalledWith(expect.stringContaining("blocked tool=shell"));
  });


  it("logs Agent Control response details when evaluation fails", async () => {
    // Given the Agent Control server rejects policy evaluation with an HTTP payload
    const api = createMockApi({
      serverUrl: "http://localhost:8000",
    });

    clientMocks.evaluationEvaluate.mockRejectedValueOnce(
      createAgentControlServerError(500, { error: "policy engine unavailable" }, "Internal Server Error"),
    );

    // When the plugin attempts to evaluate a tool call
    register(api.api);
    const result = await runBeforeToolCall(api);

    // Then the failure warning includes the HTTP status and response payload
    expect(result).toBeUndefined();
    const warning = api.warn.mock.calls
      .map(([message]) => String(message))
      .find((message) => message.includes("evaluation failed for agent=default tool=shell"));
    expect(warning).toContain("status=500");
    expect(warning).toContain('response_body={"error":"policy engine unavailable"}');
  });

  it("blocks the tool call when fail-closed evaluation throws", async () => {
    // Given fail-closed mode and an evaluation request that throws
    const api = createMockApi({
      serverUrl: "http://localhost:8000",
      failClosed: true,
    });

    clientMocks.evaluationEvaluate.mockRejectedValueOnce(new Error("eval exploded"));

    // When the plugin evaluates a tool call
    register(api.api);
    const result = await runBeforeToolCall(api);

    // Then the tool call is blocked by the evaluation failure fallback
    expect(result).toEqual({
      block: true,
      blockReason: USER_BLOCK_MESSAGE,
    });
    expect(api.warn.mock.calls.map(([message]) => String(message))).toEqual(
      expect.arrayContaining([
        expect.stringContaining("evaluation failed"),
        expect.stringContaining("reason=evaluation_failed fail_closed=true"),
      ]),
    );
  });

  it("allows the tool call when fail-open evaluation throws", async () => {
    // Given fail-open mode and an evaluation request that throws
    const api = createMockApi({
      serverUrl: "http://localhost:8000",
    });

    clientMocks.evaluationEvaluate.mockRejectedValueOnce(new Error("eval exploded"));

    // When the plugin evaluates a tool call
    register(api.api);
    const result = await runBeforeToolCall(api);

    // Then the tool call is allowed and only the failure warning is emitted
    expect(result).toBeUndefined();
    expect(api.warn).toHaveBeenCalledWith(
      expect.stringContaining("evaluation failed for agent=default tool=shell"),
    );
    expect(api.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("reason=evaluation_failed fail_closed=true"),
    );
  });
});
