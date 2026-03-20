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
  },
}));

vi.mock("../src/tool-catalog.ts", () => ({
  resolveStepsForContext: resolveStepsForContextMock,
}));

vi.mock("../src/session-context.ts", () => ({
  buildEvaluationContext: buildEvaluationContextMock,
}));

import register from "../src/agent-control-plugin.ts";

const VALID_AGENT_ID = "00000000-0000-4000-8000-000000000000";

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
  resolveStepsForContextMock.mockReset().mockResolvedValue([{ type: "tool", name: "shell" }]);
  buildEvaluationContextMock.mockReset().mockResolvedValue({ channelType: "unknown" });
});

describe("agent-control plugin logging and blocking", () => {
  it("skips initialization when the plugin is disabled", () => {
    // Given
    const api = createMockApi({
      enabled: false,
      serverUrl: "http://localhost:8000",
    });

    // When
    register(api.api);

    // Then
    expect(clientMocks.init).not.toHaveBeenCalled();
    expect(api.handlers.size).toBe(0);
  });

  it("warns and skips hook registration when no server URL is configured", () => {
    // Given
    const api = createMockApi({});

    // When
    register(api.api);

    // Then
    expect(clientMocks.init).not.toHaveBeenCalled();
    expect(api.handlers.size).toBe(0);
    expect(api.warn).toHaveBeenCalledWith(
      expect.stringContaining("disabled because serverUrl is not configured"),
    );
  });

  it("warns when the configured agent ID is not a UUID", () => {
    // Given
    const api = createMockApi({
      serverUrl: "http://localhost:8000",
      agentId: "not-a-uuid",
    });

    // When
    register(api.api);

    // Then
    expect(api.warn).toHaveBeenCalledWith(
      "agent-control: configured agentId is not a UUID: not-a-uuid",
    );
  });

  it("only logs the block event in warn mode for unsafe evaluations", async () => {
    // Given
    const api = createMockApi({
      serverUrl: "http://localhost:8000",
    });

    clientMocks.evaluationEvaluate.mockResolvedValueOnce({
      isSafe: false,
      reason: "denied by policy",
    });

    // When
    register(api.api);
    const result = await runBeforeToolCall(api);

    // Then
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
    // Given
    const api = createMockApi({
      serverUrl: "http://localhost:8000",
      logLevel: "info",
    });

    // When
    register(api.api);
    await runGatewayStart(api);
    await runBeforeToolCall(api);

    // Then
    const messages = api.info.mock.calls.map(([message]) => String(message));
    expect(messages.some((message) => message.includes("client_init"))).toBe(true);
    expect(messages.some((message) => message.includes("gateway_boot_warmup started"))).toBe(true);
    expect(messages.some((message) => message.includes("gateway_boot_warmup done"))).toBe(true);
    expect(messages.some((message) => message.includes("sync_agent"))).toBe(true);
    expect(messages.some((message) => message.includes("before_tool_call entered"))).toBe(false);
    expect(messages.some((message) => message.includes("evaluated agent="))).toBe(false);
  });

  it("emits verbose traces when the deprecated debug flag is enabled", async () => {
    // Given
    const api = createMockApi({
      serverUrl: "http://localhost:8000",
      debug: true,
    });

    // When
    register(api.api);
    await runBeforeToolCall(api);

    // Then
    const messages = api.info.mock.calls.map(([message]) => String(message));
    expect(messages.some((message) => message.includes("before_tool_call entered"))).toBe(true);
    expect(messages.some((message) => message.includes("phase=evaluate"))).toBe(true);
  });

  it("blocks the tool call before evaluation when fail-closed sync fails", async () => {
    // Given
    const api = createMockApi({
      serverUrl: "http://localhost:8000",
      failClosed: true,
    });

    resolveStepsForContextMock.mockRejectedValueOnce(new Error("resolver exploded"));

    // When
    register(api.api);
    const result = await runBeforeToolCall(api);

    // Then
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

  it("uses the base agent name when a fixed configured agent ID is present", async () => {
    // Given
    const api = createMockApi({
      serverUrl: "http://localhost:8000",
      agentId: VALID_AGENT_ID,
      agentName: "base-agent",
    });

    // When
    register(api.api);
    await runBeforeToolCall(api, {}, { agentId: "worker-1" });

    // Then
    expect(clientMocks.agentsInit).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: expect.objectContaining({
          agentName: "base-agent",
          agentMetadata: expect.objectContaining({
            openclawConfiguredAgentId: VALID_AGENT_ID,
          }),
        }),
      }),
    );
  });

  it("appends the source agent ID when no configured agent ID is present", async () => {
    // Given
    const api = createMockApi({
      serverUrl: "http://localhost:8000",
      agentName: "base-agent",
    });

    // When
    register(api.api);
    await runBeforeToolCall(api, {}, { agentId: "worker-1" });

    // Then
    expect(clientMocks.agentsInit).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: expect.objectContaining({
          agentName: "base-agent:worker-1",
        }),
      }),
    );
  });

  it("reuses warmup work across repeated gateway_start events", async () => {
    // Given
    const api = createMockApi({
      serverUrl: "http://localhost:8000",
    });

    // When
    register(api.api);
    await runGatewayStart(api);
    await runGatewayStart(api);

    // Then
    expect(resolveStepsForContextMock).toHaveBeenCalledTimes(1);
    expect(resolveStepsForContextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceAgentId: "main",
      }),
    );
  });

  it("deduplicates concurrent syncs for the same source agent", async () => {
    // Given
    const api = createMockApi({
      serverUrl: "http://localhost:8000",
    });
    const syncDeferred = createDeferred<void>();
    clientMocks.agentsInit.mockImplementation(() => syncDeferred.promise);

    // When
    register(api.api);

    const first = runBeforeToolCall(api);
    const second = runBeforeToolCall(api);
    await Promise.resolve();
    await Promise.resolve();

    expect(clientMocks.agentsInit).toHaveBeenCalledTimes(1);

    syncDeferred.resolve(undefined);
    await Promise.all([first, second]);

    // Then
    expect(clientMocks.evaluationEvaluate).toHaveBeenCalledTimes(2);
  });

  it("skips resyncing when the step catalog has not changed", async () => {
    // Given
    const api = createMockApi({
      serverUrl: "http://localhost:8000",
    });

    // When
    register(api.api);
    await runBeforeToolCall(api);
    await runBeforeToolCall(api);

    // Then
    expect(clientMocks.agentsInit).toHaveBeenCalledTimes(1);
    expect(clientMocks.evaluationEvaluate).toHaveBeenCalledTimes(2);
  });

  it("deduplicates deny controls in the block reason", async () => {
    // Given
    const api = createMockApi({
      serverUrl: "http://localhost:8000",
    });

    clientMocks.evaluationEvaluate.mockResolvedValueOnce({
      isSafe: false,
      matches: [
        { action: "deny", controlName: "alpha" },
        { action: "deny", controlName: "alpha" },
        { action: "deny", controlName: "beta" },
      ],
      errors: null,
    });

    // When
    register(api.api);
    await runBeforeToolCall(api);

    // Then
    const message = String(api.warn.mock.calls[0]?.[0]);
    expect(message).toContain("alpha, beta");
    expect(message).not.toContain("alpha, alpha");
  });

  it("logs the generic block reason when no policy details are returned", async () => {
    // Given
    const api = createMockApi({
      serverUrl: "http://localhost:8000",
    });

    clientMocks.evaluationEvaluate.mockResolvedValueOnce({
      isSafe: false,
      reason: "",
      matches: null,
      errors: null,
    });

    // When
    register(api.api);
    await runBeforeToolCall(api);

    // Then
    expect(api.warn).toHaveBeenCalledWith(
      expect.stringContaining("reason=[agent-control] blocked by policy evaluation"),
    );
  });
});
