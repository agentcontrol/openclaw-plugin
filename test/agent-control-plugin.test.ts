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

type MockApi = {
  api: OpenClawPluginApi;
  handlers: Map<string, (...args: any[]) => unknown>;
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
};

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
  it("keeps warn mode quiet except for block events", async () => {
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

  it("adds lifecycle logs in info mode without debug traces", async () => {
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

  it("accepts the deprecated debug flag as an alias for debug logging", async () => {
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

  it("blocks in fail-closed mode when step resolution fails", async () => {
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
});
