import { AgentControlClient } from "agent-control";
import type { JsonValue } from "agent-control";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { createPluginLogger, formatAgentControlError, resolveLogLevel } from "./logging.ts";
import {
  buildControlExecutionEvents,
  buildControlObservabilityIndex,
  emitControlExecutionEvents,
  resolveTraceContext,
} from "./observability.ts";
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
import type { AgentControlPluginConfig, AgentState } from "./types.ts";

function collectDenyControlNames(response: {
  matches?: Array<{ action?: string; controlName?: string }> | null;
  errors?: Array<{ action?: string; controlName?: string }> | null;
}): string[] {
  const names: string[] = [];
  for (const match of [...(response.matches ?? []), ...(response.errors ?? [])]) {
    if (
      match.action === "deny" &&
      typeof match.controlName === "string" &&
      match.controlName.trim()
    ) {
      names.push(match.controlName.trim());
    }
  }
  return [...new Set(names)];
}

function buildBlockReason(response: {
  reason?: string | null;
  matches?: Array<{ action?: string; controlName?: string }> | null;
  errors?: Array<{ action?: string; controlName?: string }> | null;
}): string {
  const denyControls = collectDenyControlNames(response);
  if (denyControls.length > 0) {
    return `[agent-control] blocked by deny control(s): ${denyControls.join(", ")}`;
  }
  if (typeof response.reason === "string" && response.reason.trim().length > 0) {
    return `[agent-control] ${response.reason.trim()}`;
  }
  return "[agent-control] blocked by policy evaluation";
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
  const observabilityEnabled = cfg.observabilityEnabled !== false;
  const baseAgentName = asString(cfg.agentName) ?? "openclaw-agent";
  const configuredAgentVersion = asString(cfg.agentVersion);
  const pluginVersion = asString(api.version);
  const clientTimeoutMs = asPositiveInt(cfg.timeoutMs);

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
  logger.info(
    `agent-control: observability enabled=${observabilityEnabled}`,
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
      controlObservabilityById: new Map(),
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
          `agent-control: gateway_boot_warmup failed duration_sec=${secondsSince(warmupStartedAt)} agent=${BOOT_WARMUP_AGENT_ID} error=${formatAgentControlError(err)}`,
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
      const syncResponse = await client.agents.init({
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
      if (Array.isArray(syncResponse?.controls)) {
        state.controlObservabilityById = buildControlObservabilityIndex(syncResponse.controls);
      }
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
          `agent-control: unable to sync agent=${sourceAgentId} before tool evaluation: ${formatAgentControlError(err)}`,
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
        const traceContext = observabilityEnabled ? resolveTraceContext() : null;
        const evaluation = await client.evaluation.evaluate({
          agentName: state.agentName,
          stage: "pre",
          step: {
            type: "tool",
            name: event.toolName,
            input: (event.params ?? null) as JsonValue,
            context: context as Record<string, JsonValue | null>,
          },
        });
        logger.debug(
          `agent-control: before_tool_call phase=evaluate duration_sec=${secondsSince(evaluateStartedAt)} agent=${sourceAgentId} tool=${event.toolName} safe=${evaluation.isSafe}`,
        );

        if (observabilityEnabled && traceContext) {
          emitControlExecutionEvents({
            client,
            logger,
            events: buildControlExecutionEvents({
              evaluation,
              agentName: state.agentName,
              stepName: event.toolName,
              stepType: "tool",
              checkStage: "pre",
              traceContext,
              controlObservabilityById: state.controlObservabilityById,
              sourceAgentId,
              pluginId: api.id,
              runId: event.runId ?? ctx.runId,
              toolCallId: event.toolCallId ?? ctx.toolCallId,
            }),
            agentName: state.agentName,
            stepName: event.toolName,
          });
        }

        if (evaluation.isSafe) {
          return;
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
          `agent-control: evaluation failed for agent=${sourceAgentId} tool=${event.toolName}: ${formatAgentControlError(err)}`,
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
