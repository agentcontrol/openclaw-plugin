import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { resolveSessionIdentity } from "./session-store.ts";
import { asString } from "./shared.ts";
import type { AgentState, ChannelType, DerivedChannelContext } from "./types.ts";

function parseAgentSessionKey(sessionKey: string | undefined): { agentId: string; scope: string } | null {
  const normalized = asString(sessionKey)?.toLowerCase();
  if (!normalized) {
    return null;
  }
  const parts = normalized.split(":").filter(Boolean);
  if (parts.length < 3 || parts[0] !== "agent") {
    return null;
  }
  const agentId = parts[1];
  const scope = parts.slice(2).join(":");
  if (!agentId || !scope) {
    return null;
  }
  return { agentId, scope };
}

function deriveChannelType(scope: string): ChannelType {
  const tokens = new Set(scope.split(":").filter(Boolean));
  if (tokens.has("group")) {
    return "group";
  }
  if (tokens.has("channel")) {
    return "channel";
  }
  if (tokens.has("direct") || tokens.has("dm")) {
    return "direct";
  }
  if (/^discord:(?:[^:]+:)?guild-[^:]+:channel-[^:]+$/.test(scope)) {
    return "channel";
  }
  return "unknown";
}

function deriveChannelContext(sessionKey: string | undefined): DerivedChannelContext {
  const parsed = parseAgentSessionKey(sessionKey);
  if (!parsed) {
    return {
      provider: null,
      type: "unknown",
      scope: null,
      source: "unknown",
    };
  }

  const scopeTokens = parsed.scope.split(":").filter(Boolean);
  const firstToken = scopeTokens[0];
  const provider =
    firstToken &&
    !["main", "subagent", "cron", "acp", "memory", "heartbeat"].includes(firstToken)
      ? firstToken
      : null;

  return {
    provider,
    type: deriveChannelType(parsed.scope),
    scope: parsed.scope,
    source: "sessionKey",
  };
}

export async function buildEvaluationContext(params: {
  api: OpenClawPluginApi;
  sourceAgentId: string;
  state: AgentState;
  event: {
    runId?: string;
    toolCallId?: string;
  };
  ctx: {
    sessionKey?: string;
    sessionId?: string;
    runId?: string;
    toolCallId?: string;
  };
  pluginVersion?: string;
  failClosed: boolean;
  configuredAgentId?: string;
  configuredAgentVersion?: string;
}): Promise<Record<string, unknown>> {
  const channelFromSessionKey = deriveChannelContext(params.ctx.sessionKey);
  const sessionIdentity = await resolveSessionIdentity(params.ctx.sessionKey);
  const mergedChannelType =
    sessionIdentity.type !== "unknown" ? sessionIdentity.type : channelFromSessionKey.type;
  const mergedChannelProvider = sessionIdentity.provider ?? channelFromSessionKey.provider;

  const channel = {
    provider: mergedChannelProvider,
    type: mergedChannelType,
    scope: channelFromSessionKey.scope,
    source:
      sessionIdentity.source === "sessionStore"
        ? "sessionStore+sessionKey"
        : channelFromSessionKey.source,
    name: sessionIdentity.channelName,
    dmUserName: sessionIdentity.dmUserName,
    label: sessionIdentity.label,
    from: sessionIdentity.from,
    to: sessionIdentity.to,
    accountId: sessionIdentity.accountId,
  };

  return {
    openclawAgentId: params.sourceAgentId,
    sessionKey: params.ctx.sessionKey ?? null,
    sessionId: params.ctx.sessionId ?? null,
    runId: params.ctx.runId ?? params.event.runId ?? null,
    toolCallId: params.ctx.toolCallId ?? params.event.toolCallId ?? null,
    channelType: mergedChannelType,
    channelName: sessionIdentity.channelName,
    dmUserName: sessionIdentity.dmUserName,
    senderFrom: sessionIdentity.from,
    channel,
    plugin: {
      id: params.api.id,
      version: params.pluginVersion ?? null,
    },
    policy: {
      failClosed: params.failClosed,
      configuredAgentId: params.configuredAgentId ?? null,
      configuredAgentVersion: params.configuredAgentVersion ?? null,
    },
    sync: {
      agentName: params.state.agentName,
      stepCount: params.state.steps.length,
      stepsHash: params.state.stepsHash,
      lastSyncedStepsHash: params.state.lastSyncedStepsHash,
    },
  };
}
