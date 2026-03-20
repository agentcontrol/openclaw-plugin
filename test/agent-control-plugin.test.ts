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
  it("Given the plugin is disabled, when it is registered, then it does not initialize the client or hooks", () => {
    const api = createMockApi({
      enabled: false,
      serverUrl: "http://localhost:8000",
    });

    register(api.api);

    expect(clientMocks.init).not.toHaveBeenCalled();
    expect(api.handlers.size).toBe(0);
  });

  it("Given no server URL is configured, when the plugin is registered, then it warns and skips hook registration", () => {
    const api = createMockApi({});

    register(api.api);

    expect(clientMocks.init).not.toHaveBeenCalled();
    expect(api.handlers.size).toBe(0);
    expect(api.warn).toHaveBeenCalledWith(
      expect.stringContaining("disabled because serverUrl is not configured"),
    );
  });

  it("Given an invalid configured agent ID, when the plugin is registered, then it warns about the invalid UUID", () => {
    const api = createMockApi({
      serverUrl: "http://localhost:8000",
      agentId: "not-a-uuid",
    });

    register(api.api);

    expect(api.warn).toHaveBeenCalledWith(
      "agent-control: configured agentId is not a UUID: not-a-uuid",
    );
  });

  it("Given warn mode, when an unsafe evaluation occurs, then only the block event is logged", async () => {
    const api = createMockApi({
      serverUrl: "http://localhost:8000",
    });

    clientMocks.evaluationEvaluate.mockResolvedValueOnce({
      isSafe: false,
      reason: "denied by policy",
    });

    register(api.api);
    const result = await runBeforeToolCall(api);

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

  it("Given info mode, when warmup and a tool evaluation run, then lifecycle logs are emitted without debug traces", async () => {
    const api = createMockApi({
      serverUrl: "http://localhost:8000",
      logLevel: "info",
    });

    register(api.api);
    await runGatewayStart(api);
    await runBeforeToolCall(api);

    const messages = api.info.mock.calls.map(([message]) => String(message));
    expect(messages.some((message) => message.includes("client_init"))).toBe(true);
    expect(messages.some((message) => message.includes("gateway_boot_warmup started"))).toBe(true);
    expect(messages.some((message) => message.includes("gateway_boot_warmup done"))).toBe(true);
    expect(messages.some((message) => message.includes("sync_agent"))).toBe(true);
    expect(messages.some((message) => message.includes("before_tool_call entered"))).toBe(false);
    expect(messages.some((message) => message.includes("evaluated agent="))).toBe(false);
  });

  it("Given the deprecated debug flag, when a tool evaluation runs, then verbose debug traces are emitted", async () => {
    const api = createMockApi({
      serverUrl: "http://localhost:8000",
      debug: true,
    });

    register(api.api);
    await runBeforeToolCall(api);

    const messages = api.info.mock.calls.map(([message]) => String(message));
    expect(messages.some((message) => message.includes("before_tool_call entered"))).toBe(true);
    expect(messages.some((message) => message.includes("phase=evaluate"))).toBe(true);
  });

  it("Given fail-closed mode, when step resolution fails, then the tool call is blocked before evaluation", async () => {
    const api = createMockApi({
      serverUrl: "http://localhost:8000",
      failClosed: true,
    });

    resolveStepsForContextMock.mockRejectedValueOnce(new Error("resolver exploded"));

    register(api.api);
    const result = await runBeforeToolCall(api);

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

  it("Given a fixed configured agent ID, when a source agent evaluates a tool, then the base agent name is used without a source suffix", async () => {
    const api = createMockApi({
      serverUrl: "http://localhost:8000",
      agentId: VALID_AGENT_ID,
      agentName: "base-agent",
    });

    register(api.api);
    await runBeforeToolCall(api, {}, { agentId: "worker-1" });

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

  it("Given no configured agent ID, when a source agent evaluates a tool, then the source agent ID is appended to the base agent name", async () => {
    const api = createMockApi({
      serverUrl: "http://localhost:8000",
      agentName: "base-agent",
    });

    register(api.api);
    await runBeforeToolCall(api, {}, { agentId: "worker-1" });

    expect(clientMocks.agentsInit).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: expect.objectContaining({
          agentName: "base-agent:worker-1",
        }),
      }),
    );
  });

  it("Given gateway warmup has already started, when gateway_start fires again, then the warmup work is reused", async () => {
    const api = createMockApi({
      serverUrl: "http://localhost:8000",
    });

    register(api.api);
    await runGatewayStart(api);
    await runGatewayStart(api);

    expect(resolveStepsForContextMock).toHaveBeenCalledTimes(1);
    expect(resolveStepsForContextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceAgentId: "main",
      }),
    );
  });

  it("Given two concurrent tool calls for the same source agent, when sync is already in flight, then Agent Control is initialized only once", async () => {
    const api = createMockApi({
      serverUrl: "http://localhost:8000",
    });
    const syncDeferred = createDeferred<void>();
    clientMocks.agentsInit.mockImplementation(() => syncDeferred.promise);

    register(api.api);

    const first = runBeforeToolCall(api);
    const second = runBeforeToolCall(api);
    await Promise.resolve();
    await Promise.resolve();

    expect(clientMocks.agentsInit).toHaveBeenCalledTimes(1);

    syncDeferred.resolve(undefined);
    await Promise.all([first, second]);

    expect(clientMocks.evaluationEvaluate).toHaveBeenCalledTimes(2);
  });

  it("Given the synced step catalog is unchanged, when the same source agent evaluates another tool, then the second call skips resyncing the agent", async () => {
    const api = createMockApi({
      serverUrl: "http://localhost:8000",
    });

    register(api.api);
    await runBeforeToolCall(api);
    await runBeforeToolCall(api);

    expect(clientMocks.agentsInit).toHaveBeenCalledTimes(1);
    expect(clientMocks.evaluationEvaluate).toHaveBeenCalledTimes(2);
  });

  it("Given duplicate deny controls in the evaluation response, when the tool call is blocked, then the block reason lists each control once", async () => {
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

    register(api.api);
    await runBeforeToolCall(api);

    const message = String(api.warn.mock.calls[0]?.[0]);
    expect(message).toContain("alpha, beta");
    expect(message).not.toContain("alpha, alpha");
  });

  it("Given no policy reason or deny controls are returned, when the tool call is blocked, then the generic block reason is logged", async () => {
    const api = createMockApi({
      serverUrl: "http://localhost:8000",
    });

    clientMocks.evaluationEvaluate.mockResolvedValueOnce({
      isSafe: false,
      reason: "",
      matches: null,
      errors: null,
    });

    register(api.api);
    await runBeforeToolCall(api);

    expect(api.warn).toHaveBeenCalledWith(
      expect.stringContaining("reason=[agent-control] blocked by policy evaluation"),
    );
  });
});
