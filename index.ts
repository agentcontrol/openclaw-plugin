import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { AgentControlClient } from "agent-control";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";

type AgentControlPluginConfig = {
  enabled?: boolean;
  serverUrl?: string;
  apiKey?: string;
  agentName?: string;
  agentId?: string;
  agentVersion?: string;
  timeoutMs?: number;
  userAgent?: string;
  failClosed?: boolean;
};

type AgentControlStep = {
  type: "tool";
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

type AgentState = {
  sourceAgentId: string;
  agentName: string;
  steps: AgentControlStep[];
  stepsHash: string;
  lastSyncedStepsHash: string | null;
  syncPromise: Promise<void> | null;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const requireFromPlugin = createRequire(import.meta.url);

type ToolCatalogInternals = {
  createOpenClawCodingTools: (params: {
    agentId: string;
    sessionKey?: string;
    sessionId?: string;
    runId?: string;
    config: OpenClawPluginApi["config"];
    senderIsOwner: boolean;
  }) => unknown[];
  toToolDefinitions: (tools: unknown[]) => Array<{
    name: string;
    label?: string;
    description?: string;
    parameters?: unknown;
  }>;
};

let toolCatalogInternalsPromise: Promise<ToolCatalogInternals> | null = null;

function readPackageName(packageJsonPath: string): string | undefined {
  try {
    const raw = fs.readFileSync(packageJsonPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return undefined;
    }
    const name = (parsed as { name?: unknown }).name;
    return typeof name === "string" ? name : undefined;
  } catch {
    return undefined;
  }
}

function findOpenClawRootFrom(startPath: string | undefined): string | undefined {
  if (!startPath) {
    return undefined;
  }
  let cursor = path.resolve(startPath);
  while (true) {
    const packageJson = path.join(cursor, "package.json");
    if (fs.existsSync(packageJson) && readPackageName(packageJson) === "openclaw") {
      return cursor;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      return undefined;
    }
    cursor = parent;
  }
}

function resolveOpenClawRootDir(): string {
  try {
    const pkgJson = requireFromPlugin.resolve("openclaw/package.json");
    return path.dirname(pkgJson);
  } catch {
    // Fall through to process-based probing below.
  }

  const argvEntry = process.argv[1];
  const argvEntryRealpath = (() => {
    if (!argvEntry) {
      return undefined;
    }
    try {
      return fs.realpathSync(argvEntry);
    } catch {
      return undefined;
    }
  })();

  const candidates = [
    argvEntry ? findOpenClawRootFrom(path.dirname(argvEntry)) : undefined,
    argvEntryRealpath ? findOpenClawRootFrom(path.dirname(argvEntryRealpath)) : undefined,
    findOpenClawRootFrom(process.cwd()),
  ];
  const found = candidates.find((entry): entry is string => typeof entry === "string");
  if (!found) {
    throw new Error(
      "agent-control: unable to resolve openclaw package root for internal tool schema access",
    );
  }
  return found;
}

async function importOpenClawInternalModule(
  openClawRoot: string,
  candidates: string[],
): Promise<Record<string, unknown>> {
  let lastErr: unknown;
  for (const relativePath of candidates) {
    const absolutePath = path.join(openClawRoot, relativePath);
    if (!fs.existsSync(absolutePath)) {
      continue;
    }
    try {
      return (await import(pathToFileURL(absolutePath).href)) as Record<string, unknown>;
    } catch (err) {
      lastErr = err;
    }
  }
  throw (
    lastErr ??
    new Error(
      `agent-control: openclaw internal module not found (${candidates.join(", ")}) under ${openClawRoot}`,
    )
  );
}

async function loadToolCatalogInternals(): Promise<ToolCatalogInternals> {
  if (toolCatalogInternalsPromise) {
    return toolCatalogInternalsPromise;
  }

  toolCatalogInternalsPromise = (async () => {
    const openClawRoot = resolveOpenClawRootDir();
    const [piToolsModule, adapterModule] = await Promise.all([
      importOpenClawInternalModule(openClawRoot, ["dist/agents/pi-tools.js"]),
      importOpenClawInternalModule(openClawRoot, ["dist/agents/pi-tool-definition-adapter.js"]),
    ]);

    const createOpenClawCodingTools = piToolsModule.createOpenClawCodingTools;
    const toToolDefinitions = adapterModule.toToolDefinitions;
    if (typeof createOpenClawCodingTools !== "function") {
      throw new Error("agent-control: openclaw internal createOpenClawCodingTools is unavailable");
    }
    if (typeof toToolDefinitions !== "function") {
      throw new Error("agent-control: openclaw internal toToolDefinitions is unavailable");
    }

    return {
      createOpenClawCodingTools: createOpenClawCodingTools as ToolCatalogInternals["createOpenClawCodingTools"],
      toToolDefinitions: toToolDefinitions as ToolCatalogInternals["toToolDefinitions"],
    };
  })();

  return toolCatalogInternalsPromise;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asPositiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toJsonRecord(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  try {
    const encoded = JSON.stringify(value);
    if (typeof encoded !== "string") {
      return undefined;
    }
    const parsed = JSON.parse(encoded) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

function trimToMax(value: string, maxLen: number): string {
  return value.length <= maxLen ? value : value.slice(0, maxLen);
}

function hashSteps(steps: AgentControlStep[]): string {
  return createHash("sha256").update(JSON.stringify(steps)).digest("hex");
}

function buildSteps(
  tools: Array<{ name: string; label?: string; description?: string; parameters?: unknown }>,
): AgentControlStep[] {
  const deduped = new Map<string, AgentControlStep>();

  for (const tool of tools) {
    const name = asString(tool.name);
    if (!name) {
      continue;
    }

    const step: AgentControlStep = {
      type: "tool",
      name,
    };

    const description = asString(tool.description) ?? asString(tool.label);
    if (description) {
      step.description = description;
    }

    const inputSchema = toJsonRecord(tool.parameters);
    if (inputSchema) {
      step.inputSchema = inputSchema;
    }

    const label = asString(tool.label);
    if (label) {
      step.metadata = { label };
    }

    deduped.set(name, step);
  }

  return [...deduped.values()];
}

async function resolveStepsForContext(params: {
  api: OpenClawPluginApi;
  sourceAgentId: string;
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
}): Promise<AgentControlStep[]> {
  const internals = await loadToolCatalogInternals();
  const tools = internals.createOpenClawCodingTools({
    agentId: params.sourceAgentId,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    runId: params.runId,
    config: params.api.config,
    // Keep the synced step catalog permissive so guardrail policy sees the full
    // internal tool surface when sender ownership is unknown in this hook context.
    senderIsOwner: true,
  });
  const toolDefinitions = internals.toToolDefinitions(tools);
  return buildSteps(
    toolDefinitions.map((tool) => ({
      name: tool.name,
      label: tool.label,
      description: tool.description,
      parameters: tool.parameters,
    })),
  );
}

function collectDenyControlNames(response: {
  matches?: Array<{ action?: string; controlName?: string }>;
  errors?: Array<{ action?: string; controlName?: string }>;
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
  matches?: Array<{ action?: string; controlName?: string }>;
  errors?: Array<{ action?: string; controlName?: string }>;
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

function formatToolArgsForLog(params: unknown): string {
  if (params === undefined) {
    return "undefined";
  }
  try {
    const encoded = JSON.stringify(params);
    if (typeof encoded !== "string") {
      return trimToMax(String(params), 1000);
    }
    return trimToMax(encoded, 1000);
  } catch {
    return "[unserializable]";
  }
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

  const serverUrl = asString(cfg.serverUrl) ?? asString(process.env.AGENT_CONTROL_SERVER_URL);
  if (!serverUrl) {
    api.logger.warn(
      "agent-control: disabled because serverUrl is not configured (plugins.entries.agent-control.serverUrl)",
    );
    return;
  }

  const configuredAgentId = asString(cfg.agentId);
  if (configuredAgentId && !isUuid(configuredAgentId)) {
    api.logger.warn(`agent-control: configured agentId is not a UUID: ${configuredAgentId}`);
  }
  const hasConfiguredAgentId = configuredAgentId ? isUuid(configuredAgentId) : false;

  const failClosed = cfg.failClosed === true;
  const baseAgentName = asString(cfg.agentName) ?? "openclaw-agent";
  const configuredAgentVersion = asString(cfg.agentVersion);

  const client = new AgentControlClient();
  client.init({
    agentName: baseAgentName,
    serverUrl,
    apiKey: asString(cfg.apiKey) ?? asString(process.env.AGENT_CONTROL_API_KEY),
    timeoutMs: asPositiveInt(cfg.timeoutMs),
    userAgent: asString(cfg.userAgent) ?? "openclaw-agent-control-plugin/0.1",
  });

  const states = new Map<string, AgentState>();

  const getOrCreateState = (sourceAgentId: string): AgentState => {
    const existing = states.get(sourceAgentId);
    if (existing) {
      return existing;
    }

    const agentName = hasConfiguredAgentId
      ? trimToMax(baseAgentName, 255)
      : trimToMax(`${baseAgentName}:${sourceAgentId}`, 255);

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
      await client.agents.init({
        agent: {
          agentName: state.agentName,
          agentVersion: configuredAgentVersion,
          agentMetadata: {
            source: "openclaw",
            openclawAgentId: state.sourceAgentId,
            ...(configuredAgentId ? { openclawConfiguredAgentId: configuredAgentId } : {}),
            pluginId: api.id,
          },
        },
        steps: state.steps,
      });
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

  api.on(
    "before_tool_call",
    async (event, ctx) => {
      const sourceAgentId = resolveSourceAgentId(ctx.agentId);
      const state = getOrCreateState(sourceAgentId);
      const argsForLog = formatToolArgsForLog(event.params);
      api.logger.info(
        `agent-control: before_tool_call entered agent=${sourceAgentId} tool=${event.toolName} args=${argsForLog}`,
      );

      try {
        const nextSteps = await resolveStepsForContext({
          api,
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
        await syncAgent(state);
      } catch (err) {
        api.logger.warn(
          `agent-control: unable to sync agent=${sourceAgentId} before tool evaluation: ${String(err)}`,
        );
        if (failClosed) {
          return {
            block: true,
            blockReason:
              "[agent-control] blocked: guardrail service unavailable (registration failed)",
          };
        }
        return;
      }

      try {
        const evaluation = await client.evaluation.evaluate({
          body: {
            agentName: state.agentName,
            stage: "pre",
            step: {
              type: "tool",
              name: event.toolName,
              input: event.params,
              context: {
                openclawAgentId: sourceAgentId,
                sessionKey: ctx.sessionKey ?? null,
              },
            },
          },
        });

        if (evaluation.isSafe) {
          api.logger.info("safe !");
          return;
        }

        api.logger.info("unsafe !");

        return {
          block: true,
          blockReason: buildBlockReason(evaluation),
        };
      } catch (err) {
        api.logger.warn(
          `agent-control: evaluation failed for agent=${sourceAgentId} tool=${event.toolName}: ${String(err)}`,
        );
        if (failClosed) {
          return {
            block: true,
            blockReason:
              "[agent-control] blocked: guardrail service unavailable (evaluation failed)",
          };
        }
      }
    },
    { priority: 100 },
  );
}
