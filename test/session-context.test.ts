import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { resolveSessionIdentityMock } = vi.hoisted(() => ({
  resolveSessionIdentityMock: vi.fn(),
}));

vi.mock("../src/session-store.ts", () => ({
  resolveSessionIdentity: resolveSessionIdentityMock,
}));

import { buildEvaluationContext } from "../src/session-context.ts";

function createApi(): OpenClawPluginApi {
  return {
    id: "agent-control-openclaw-plugin",
    version: "test-version",
    config: {},
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
    },
    on: vi.fn(),
  };
}

beforeEach(() => {
  resolveSessionIdentityMock.mockReset().mockResolvedValue({
    provider: null,
    type: "unknown",
    channelName: null,
    dmUserName: null,
    label: null,
    from: null,
    to: null,
    accountId: null,
    source: "unknown",
  });
});

describe("buildEvaluationContext", () => {
  it("derives channel details from the session key when store metadata is unknown", async () => {
    // Given
    const request = {
      api: createApi(),
      sourceAgentId: "worker-1",
      state: {
        sourceAgentId: "worker-1",
        agentName: "base-agent:worker-1",
        steps: [],
        stepsHash: "hash-1",
        lastSyncedStepsHash: null,
        syncPromise: null,
      },
      event: {
        runId: "event-run",
        toolCallId: "event-call",
      },
      ctx: {
        sessionKey: "agent:worker-1:discord:guild-1:channel-2",
      },
      failClosed: false,
    };

    // When
    const context = await buildEvaluationContext(request);

    // Then
    expect(context).toMatchObject({
      openclawAgentId: "worker-1",
      channelType: "channel",
      runId: "event-run",
      toolCallId: "event-call",
      channel: {
        provider: "discord",
        type: "channel",
        scope: "discord:guild-1:channel-2",
        source: "sessionKey",
      },
    });
  });

  it("prefers session-store provider and type while retaining the key scope", async () => {
    // Given
    resolveSessionIdentityMock.mockResolvedValueOnce({
      provider: "slack",
      type: "direct",
      channelName: null,
      dmUserName: "Alice",
      label: "Alice",
      from: "alice@example.com",
      to: "bot@example.com",
      accountId: "acct-1",
      source: "sessionStore",
    });

    const request = {
      api: createApi(),
      sourceAgentId: "worker-1",
      state: {
        sourceAgentId: "worker-1",
        agentName: "base-agent:worker-1",
        steps: [{ type: "tool", name: "shell" }],
        stepsHash: "hash-1",
        lastSyncedStepsHash: "hash-0",
        syncPromise: null,
      },
      event: {},
      ctx: {
        sessionKey: "agent:worker-1:discord:group:team-room",
        runId: "ctx-run",
        toolCallId: "ctx-call",
      },
      failClosed: true,
      configuredAgentId: "configured-agent",
      configuredAgentVersion: "2026.03.20",
      pluginVersion: "test-version",
    };

    // When
    const context = await buildEvaluationContext(request);

    // Then
    expect(context).toMatchObject({
      runId: "ctx-run",
      toolCallId: "ctx-call",
      channelType: "direct",
      dmUserName: "Alice",
      senderFrom: "alice@example.com",
      policy: {
        failClosed: true,
        configuredAgentId: "configured-agent",
        configuredAgentVersion: "2026.03.20",
      },
      sync: {
        agentName: "base-agent:worker-1",
        stepCount: 1,
        stepsHash: "hash-1",
        lastSyncedStepsHash: "hash-0",
      },
      channel: {
        provider: "slack",
        type: "direct",
        scope: "discord:group:team-room",
        source: "sessionStore+sessionKey",
        dmUserName: "Alice",
        from: "alice@example.com",
      },
    });
  });

  it("falls back to unknown channel information for an unparseable session key", async () => {
    // Given
    const request = {
      api: createApi(),
      sourceAgentId: "worker-1",
      state: {
        sourceAgentId: "worker-1",
        agentName: "base-agent:worker-1",
        steps: [],
        stepsHash: "hash-1",
        lastSyncedStepsHash: null,
        syncPromise: null,
      },
      event: {},
      ctx: {
        sessionKey: "not-an-agent-session-key",
      },
      failClosed: false,
    };

    // When
    const context = await buildEvaluationContext(request);

    // Then
    expect(context).toMatchObject({
      channelType: "unknown",
      channelName: null,
      dmUserName: null,
      senderFrom: null,
      channel: {
        provider: null,
        type: "unknown",
        scope: null,
        source: "unknown",
      },
    });
  });
});
