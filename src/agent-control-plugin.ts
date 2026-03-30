import { AgentControlClient } from "agent-control";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { createPluginLogger, resolveLogLevel } from "./logging.ts";
import { resolveStepsForContext } from "./tool-catalog.ts";
import { buildEvaluationContext } from "./session-context.ts";
import {
  asPositiveInt,
  asString,
  BOOT_WARMUP_AGENT_ID,
  formatToolArgsForLog,
  hashSteps,
  isRecord,
  secondsSince,
  trimToMax,
  USER_BLOCK_MESSAGE,
} from "./shared.ts";
import type { AgentControlPluginConfig, AgentState, SteerBehavior } from "./types.ts";

const APPROVAL_TITLE = "Agent Control approval required";
const APPROVAL_TIMEOUT_MS = 120_000;
const DEFAULT_STEER_GUIDANCE = "Tool call requires operator approval due to steering policy.";

type PolicyMatch = {
  action?: string | null;
  controlName?: string | null;
  steeringContext?: {
    message?: string | null;
  } | null;
};

type PolicyResponse = {
  reason?: string | null;
  matches?: PolicyMatch[] | null;
  errors?: PolicyMatch[] | null;
};

function hasPolicyAction(
  response: PolicyResponse,
  action: "deny" | "steer",
  includeErrors: boolean,
): boolean {
  const entries = includeErrors
    ? [...(response.matches ?? []), ...(response.errors ?? [])]
    : [...(response.matches ?? [])];
  return entries.some((entry) => entry.action === action);
}

function collectControlNames(
  entries: PolicyMatch[],
  action: "deny" | "steer",
): string[] {
  const names: string[] = [];
  for (const entry of entries) {
    if (
      entry.action === action &&
      typeof entry.controlName === "string" &&
      entry.controlName.trim()
    ) {
      names.push(entry.controlName.trim());
    }
  }
  return [...new Set(names)];
}

function collectDenyControlNames(response: PolicyResponse): string[] {
  return collectControlNames([...(response.matches ?? []), ...(response.errors ?? [])], "deny");
}

function collectSteerMatches(response: PolicyResponse): PolicyMatch[] {
  return (response.matches ?? []).filter((match) => match.action === "steer");
}

function collectSteerControlNames(response: PolicyResponse): string[] {
  return collectControlNames(collectSteerMatches(response), "steer");
}

function buildBlockReason(response: PolicyResponse): string {
  const denyControls = collectDenyControlNames(response);
  if (denyControls.length > 0) {
    return `[agent-control] blocked by deny control(s): ${denyControls.join(", ")}`;
  }
  if (typeof response.reason === "string" && response.reason.trim().length > 0) {
    return `[agent-control] ${response.reason.trim()}`;
  }
  return "[agent-control] blocked by policy evaluation";
}

function resolveSteerGuidance(response: PolicyResponse): string {
  for (const match of collectSteerMatches(response)) {
    const steeringMessage = asString(match.steeringContext?.message)?.trim();
    if (steeringMessage) {
      return steeringMessage;
    }
  }

  const reason = asString(response.reason)?.trim();
  if (reason) {
    return reason;
  }

  return DEFAULT_STEER_GUIDANCE;
}

function buildSteerReason(response: PolicyResponse): string {
  const steerControls = collectSteerControlNames(response);
  const guidance = resolveSteerGuidance(response);
  if (steerControls.length > 0) {
    return `[agent-control] blocked by steer control(s): ${steerControls.join(", ")}; guidance: ${guidance}`;
  }
  return `[agent-control] ${guidance}`;
}

function buildApprovalDescription(toolName: string, response: PolicyResponse): string {
  const steerControls = collectSteerControlNames(response);
  const guidance = resolveSteerGuidance(response);
  const controlSummary =
    steerControls.length > 0
      ? `matched steering control(s): ${steerControls.join(", ")}`
      : "matched a steering policy";
  return `Tool call "${toolName}" ${controlSummary}. Guidance: ${guidance}`;
}

function resolveSourceAgentId(agentId: string | undefined): string {
  const normalized = asString(agentId);
  return normalized ?? "default";
}

function loadPluginConfig(api: OpenClawPluginApi): AgentControlPluginConfig {
  const raw = isRecord(api.pluginConfig) ? api.pluginConfig : {};
  return raw as unknown as AgentControlPluginConfig;
}

export default function register(api: OpenClawPluginApi) {
  const cfg = loadPluginConfig(api);
  if (cfg.enabled === false) {
    return;
  }
  const logger = createPluginLogger(api.logger, resolveLogLevel(cfg));

  const serverUrl = asString(cfg.serverUrl) ?? asString(process.env.AGENT_CONTROL_SERVER_URL);
  if (!serverUrl) {
    logger.warn(
      "agent-control: disabled because serverUrl is not configured (plugins.entries.agent-control-openclaw-plugin.config.serverUrl)",
    );
    return;
  }

  const failClosed = cfg.failClosed === true;
  const baseAgentName = asString(cfg.agentName) ?? "openclaw-agent";
  const configuredAgentVersion = asString(cfg.agentVersion);
  const pluginVersion = asString(api.version);
  const clientTimeoutMs = asPositiveInt(cfg.timeoutMs);
  const steerBehavior: SteerBehavior = cfg.steerBehavior === "block" ? "block" : "requireApproval";

  const clientInitStartedAt = process.hrtime.bigint();
  const client = new AgentControlClient();
  client.init({
    agentName: baseAgentName,
    serverUrl,
    apiKey: asString(cfg.apiKey) ?? asString(process.env.AGENT_CONTROL_API_KEY),
    timeoutMs: clientTimeoutMs,
    userAgent: asString(cfg.userAgent) ?? "openclaw-agent-control-plugin/0.1",
  });
  logger.info(
    `agent-control: client_init duration_sec=${secondsSince(clientInitStartedAt)} timeout_ms=${clientTimeoutMs ?? "default"} server_url=${serverUrl}`,
  );

  const states = new Map<string, AgentState>();
  let gatewayWarmupPromise: Promise<void> | null = null;
  let gatewayWarmupStatus: "idle" | "running" | "done" | "failed" = "idle";

  const getOrCreateState = (sourceAgentId: string): AgentState => {
    const existing = states.get(sourceAgentId);
    if (existing) {
      return existing;
    }

    const agentName = trimToMax(`${baseAgentName}:${sourceAgentId}`, 255);

    const created: AgentState = {
      sourceAgentId,
      agentName,
      steps: [],
      stepsHash: hashSteps([]),
      lastSyncedStepsHash: null,
      syncPromise: null,
    };
    states.set(sourceAgentId, created);
    return created;
  };

  const ensureGatewayWarmup = (): Promise<void> => {
    if (gatewayWarmupPromise) {
      return gatewayWarmupPromise;
    }

    const warmupStartedAt = process.hrtime.bigint();
    gatewayWarmupStatus = "running";
    logger.info(`agent-control: gateway_boot_warmup started agent=${BOOT_WARMUP_AGENT_ID}`);

    // Warm the exact resolver path used during tool evaluation so the gateway
    // process retains the expensive module graph in memory after startup.
    gatewayWarmupPromise = resolveStepsForContext({
      api,
      logger,
      sourceAgentId: BOOT_WARMUP_AGENT_ID,
    })
      .then((steps) => {
        gatewayWarmupStatus = "done";
        logger.info(
          `agent-control: gateway_boot_warmup done duration_sec=${secondsSince(warmupStartedAt)} agent=${BOOT_WARMUP_AGENT_ID} steps=${steps.length}`,
        );
      })
      .catch((err) => {
        gatewayWarmupStatus = "failed";
        logger.warn(
          `agent-control: gateway_boot_warmup failed duration_sec=${secondsSince(warmupStartedAt)} agent=${BOOT_WARMUP_AGENT_ID} error=${String(err)}`,
        );
      });

    return gatewayWarmupPromise;
  };

  const syncAgent = async (state: AgentState): Promise<void> => {
    if (state.syncPromise) {
      await state.syncPromise;
      return;
    }
    if (state.lastSyncedStepsHash === state.stepsHash) {
      return;
    }

    const currentHash = state.stepsHash;
    const promise = (async () => {
      const syncStartedAt = process.hrtime.bigint();
      await client.agents.init({
        agent: {
          agentName: state.agentName,
          agentVersion: configuredAgentVersion,
          agentMetadata: {
            source: "openclaw",
            openclawAgentId: state.sourceAgentId,
            pluginId: api.id,
          },
        },
        steps: state.steps,
      });
      logger.info(
        `agent-control: sync_agent duration_sec=${secondsSince(syncStartedAt)} agent=${state.sourceAgentId} step_count=${state.steps.length}`,
      );
      state.lastSyncedStepsHash = currentHash;
    })().finally(() => {
      state.syncPromise = null;
    });

    state.syncPromise = promise;
    await promise;

    // If tools changed while we were syncing, reconcile immediately.
    if (state.stepsHash !== state.lastSyncedStepsHash) {
      await syncAgent(state);
    }
  };

  api.on("gateway_start", async () => {
    await ensureGatewayWarmup();
  });

  api.on("before_tool_call", async (event, ctx) => {
    const beforeToolCallStartedAt = process.hrtime.bigint();
    const sourceAgentId = resolveSourceAgentId(ctx.agentId);
    const state = getOrCreateState(sourceAgentId);
    const argsForLog = formatToolArgsForLog(event.params);
    logger.debug(
      `agent-control: before_tool_call entered agent=${sourceAgentId} tool=${event.toolName} args=${argsForLog}`,
    );

    try {
      if (gatewayWarmupStatus === "running" && gatewayWarmupPromise) {
        const warmupWaitStartedAt = process.hrtime.bigint();
        logger.debug(
          `agent-control: before_tool_call waiting_for_gateway_boot_warmup=true agent=${sourceAgentId} tool=${event.toolName}`,
        );
        await gatewayWarmupPromise;
        logger.debug(
          `agent-control: before_tool_call phase=wait_boot_warmup duration_sec=${secondsSince(warmupWaitStartedAt)} agent=${sourceAgentId} tool=${event.toolName} warmup_status=${gatewayWarmupStatus}`,
        );
      }

      try {
        const resolveStepsStartedAt = process.hrtime.bigint();
        const nextSteps = await resolveStepsForContext({
          api,
          logger,
          sourceAgentId,
          sessionKey: ctx.sessionKey,
          sessionId: ctx.sessionId,
          runId: ctx.runId,
        });
        const nextStepsHash = hashSteps(nextSteps);
        if (nextStepsHash !== state.stepsHash) {
          state.steps = nextSteps;
          state.stepsHash = nextStepsHash;
        }
        logger.debug(
          `agent-control: before_tool_call phase=resolve_steps duration_sec=${secondsSince(resolveStepsStartedAt)} agent=${sourceAgentId} tool=${event.toolName} steps=${nextSteps.length}`,
        );

        const syncStartedAt = process.hrtime.bigint();
        await syncAgent(state);
        logger.debug(
          `agent-control: before_tool_call phase=sync_agent duration_sec=${secondsSince(syncStartedAt)} agent=${sourceAgentId} tool=${event.toolName} step_count=${state.steps.length}`,
        );
      } catch (err) {
        logger.warn(
          `agent-control: unable to sync agent=${sourceAgentId} before tool evaluation: ${String(err)}`,
        );
        if (failClosed) {
          logger.block(
            `agent-control: blocked tool=${event.toolName} agent=${sourceAgentId} reason=agent_sync_failed fail_closed=true`,
          );
          return {
            block: true,
            blockReason: USER_BLOCK_MESSAGE,
          };
        }
        return;
      }

      try {
        const contextBuildStartedAt = process.hrtime.bigint();
        const context = await buildEvaluationContext({
          api,
          sourceAgentId,
          state,
          event: {
            runId: event.runId,
            toolCallId: event.toolCallId,
          },
          ctx: {
            sessionKey: ctx.sessionKey,
            sessionId: ctx.sessionId,
            runId: ctx.runId,
            toolCallId: ctx.toolCallId,
          },
          pluginVersion,
          failClosed,
          configuredAgentVersion,
        });
        logger.debug(
          `agent-control: before_tool_call phase=build_context duration_sec=${secondsSince(contextBuildStartedAt)} agent=${sourceAgentId} tool=${event.toolName}`,
        );

        logger.debug(
          `agent-control: before_tool_call evaluated agent=${sourceAgentId} tool=${event.toolName} args=${argsForLog} context=${JSON.stringify(context, null, 2)}`,
        );

        const evaluateStartedAt = process.hrtime.bigint();
        const evaluation = await client.evaluation.evaluate({
          body: {
            agentName: state.agentName,
            stage: "pre",
            step: {
              type: "tool",
              name: event.toolName,
              input: event.params,
              context,
            },
          },
        });
        logger.debug(
          `agent-control: before_tool_call phase=evaluate duration_sec=${secondsSince(evaluateStartedAt)} agent=${sourceAgentId} tool=${event.toolName} safe=${evaluation.isSafe}`,
        );

        if (evaluation.isSafe) {
          return;
        }

        if (hasPolicyAction(evaluation, "deny", true)) {
          logger.block(
            `agent-control: blocked tool=${event.toolName} agent=${sourceAgentId} reason=${buildBlockReason(evaluation)}`,
          );
          return {
            block: true,
            blockReason: USER_BLOCK_MESSAGE,
          };
        }

        if (hasPolicyAction(evaluation, "steer", false)) {
          if (steerBehavior === "block") {
            logger.block(
              `agent-control: blocked tool=${event.toolName} agent=${sourceAgentId} reason=${buildSteerReason(evaluation)} policy_action=steer`,
            );
            return {
              block: true,
              blockReason: USER_BLOCK_MESSAGE,
            };
          }

          const description = buildApprovalDescription(event.toolName, evaluation);
          logger.warn(
            `agent-control: approval_required tool=${event.toolName} agent=${sourceAgentId} reason=${description}`,
          );
          return {
            requireApproval: {
              title: APPROVAL_TITLE,
              description,
              severity: "warning",
              timeoutMs: APPROVAL_TIMEOUT_MS,
              timeoutBehavior: "deny",
            },
          };
        }

        logger.block(
          `agent-control: blocked tool=${event.toolName} agent=${sourceAgentId} reason=${buildBlockReason(evaluation)}`,
        );
        return {
          block: true,
          blockReason: USER_BLOCK_MESSAGE,
        };
      } catch (err) {
        logger.warn(
          `agent-control: evaluation failed for agent=${sourceAgentId} tool=${event.toolName}: ${String(err)}`,
        );
        if (failClosed) {
          logger.block(
            `agent-control: blocked tool=${event.toolName} agent=${sourceAgentId} reason=evaluation_failed fail_closed=true`,
          );
          return {
            block: true,
            blockReason: USER_BLOCK_MESSAGE,
          };
        }
        return;
      }
    } finally {
      logger.debug(
        `agent-control: before_tool_call duration_sec=${secondsSince(beforeToolCallStartedAt)} agent=${sourceAgentId} tool=${event.toolName}`,
      );
    }
  });
}
