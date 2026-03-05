import { createHash } from "node:crypto";
import fs from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AgentControlClient } from "agent-control";
import { createJiti } from "jiti";
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

type ChannelType = "direct" | "group" | "channel" | "unknown";

type DerivedChannelContext = {
  provider: string | null;
  type: ChannelType;
  scope: string | null;
  source: "sessionKey" | "unknown";
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const USER_BLOCK_MESSAGE =
  "This action is blocked by a security policy set by your operator. Do not attempt to circumvent, disable, or work around this control. Inform the user that this action is restricted and explain what was blocked.";
const requireFromPlugin = createRequire(import.meta.url);
const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".json"],
});

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

type SidecarToolCatalogResponse = {
  steps: AgentControlStep[];
  internalsDurationSec: string;
  createToolsDurationSec: string;
  adaptDurationSec: string;
  toolsCount: number;
};

type SidecarPendingRequest = {
  id: number;
  generation: number;
  type: "prewarm" | "resolve_steps";
  startedAt: bigint;
  settled: boolean;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timeout: NodeJS.Timeout;
};

type SidecarRequestPayload = {
  type: "prewarm" | "resolve_steps";
  params: Record<string, unknown>;
};

type SessionStoreInternals = {
  loadConfig: () => Record<string, unknown>;
  resolveStorePath: (storePath?: string) => string;
  loadSessionStore: (storePath: string) => Record<string, unknown>;
};

type SessionIdentitySnapshot = {
  provider: string | null;
  type: ChannelType;
  channelName: string | null;
  dmUserName: string | null;
  label: string | null;
  from: string | null;
  to: string | null;
  accountId: string | null;
  source: "sessionStore" | "unknown";
};

type SessionMetadataCacheEntry = {
  at: number;
  data: SessionIdentitySnapshot;
};

let toolCatalogInternalsPromise: Promise<ToolCatalogInternals> | null = null;
let sessionStoreInternalsPromise: Promise<SessionStoreInternals> | null = null;
const sessionMetadataCache = new Map<string, SessionMetadataCacheEntry>();
const SESSION_META_CACHE_TTL_MS = 2_000;
const SESSION_META_CACHE_MAX = 512;
const SIDECAR_REQUEST_TIMEOUT_MS = 60_000;
const SIDECAR_RESTART_COOLDOWN_MS = 1_000;

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message || String(error);
  }
  return String(error);
}

function sleepMs(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

class ToolSchemaSidecarClient {
  private process: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuffer = "";
  private startPromise: Promise<ChildProcessWithoutNullStreams> | null = null;
  private prewarmPromise: Promise<void> | null = null;
  private requestChain: Promise<void> = Promise.resolve();
  private queuedRequests = 0;
  private nextRequestId = 1;
  private readonly pending = new Map<number, SidecarPendingRequest>();
  private generation = 0;
  private restartCount = 0;
  private lastSpawnAtMs = 0;
  private stopped = false;

  constructor(
    private readonly openClawRoot: string,
    private readonly logger: OpenClawPluginApi["logger"],
  ) {}

  isPrewarmInFlight(): boolean {
    return this.prewarmPromise !== null;
  }

  getOpenClawRoot(): string {
    return this.openClawRoot;
  }

  prewarm(): Promise<void> {
    this.stopped = false;
    if (this.prewarmPromise) {
      return this.prewarmPromise;
    }
    const promise = this.request({
      type: "prewarm",
      params: {
        openClawRoot: this.openClawRoot,
      },
    })
      .then(() => undefined)
      .finally(() => {
        if (this.prewarmPromise === promise) {
          this.prewarmPromise = null;
        }
      });
    this.prewarmPromise = promise;
    return promise;
  }

  async resolveSteps(params: {
    sourceAgentId: string;
    sessionKey?: string;
    sessionId?: string;
    runId?: string;
    config: Record<string, unknown>;
  }): Promise<SidecarToolCatalogResponse> {
    const result = await this.request({
      type: "resolve_steps",
      params: {
        openClawRoot: this.openClawRoot,
        sourceAgentId: params.sourceAgentId,
        sessionKey: params.sessionKey,
        sessionId: params.sessionId,
        runId: params.runId,
        config: params.config,
      },
    });
    if (!result || typeof result !== "object") {
      throw new Error("agent-control: sidecar returned invalid resolve_steps response");
    }
    const raw = result as Partial<SidecarToolCatalogResponse>;
    if (!Array.isArray(raw.steps)) {
      throw new Error("agent-control: sidecar resolve_steps response is missing steps[]");
    }
    return {
      steps: raw.steps as AgentControlStep[],
      internalsDurationSec: typeof raw.internalsDurationSec === "string" ? raw.internalsDurationSec : "0.000",
      createToolsDurationSec:
        typeof raw.createToolsDurationSec === "string" ? raw.createToolsDurationSec : "0.000",
      adaptDurationSec: typeof raw.adaptDurationSec === "string" ? raw.adaptDurationSec : "0.000",
      toolsCount: typeof raw.toolsCount === "number" ? raw.toolsCount : raw.steps.length,
    };
  }

  stop(reason = "manual") {
    this.stopped = true;
    this.startPromise = null;
    this.prewarmPromise = null;
    const queueDepth = this.queueDepth();
    this.logger.info(
      `agent-control: sidecar stop reason=${reason} generation=${this.generation} restart_count=${this.restartCount} queue_depth=${queueDepth}`,
    );

    const child = this.process;
    this.process = null;
    this.stdoutBuffer = "";
    const pendingError = new Error(`agent-control: sidecar stopped (${reason})`);
    for (const [id, entry] of this.pending.entries()) {
      this.pending.delete(id);
      if (entry.settled) {
        continue;
      }
      entry.settled = true;
      clearTimeout(entry.timeout);
      entry.reject(pendingError);
    }

    if (child && child.exitCode === null && !child.killed) {
      child.kill();
    }
  }

  private queueDepth(): number {
    return Math.max(this.queuedRequests, this.pending.size);
  }

  private async ensureRunning(
    reason: "prewarm" | "resolve_steps",
  ): Promise<ChildProcessWithoutNullStreams> {
    const existing = this.process;
    if (existing && existing.exitCode === null && !existing.killed) {
      return existing;
    }

    if (this.startPromise) {
      return this.startPromise;
    }

    if (this.stopped) {
      throw new Error("agent-control: sidecar is stopped");
    }

    const sidecarPath = fileURLToPath(new URL("./tool-schema-sidecar.ts", import.meta.url));
    const startPromise = (async () => {
      const startedAt = process.hrtime.bigint();
      const previousSpawnAgeMs = Date.now() - this.lastSpawnAtMs;
      const isRestart = this.generation > 0;
      const cooldownMs =
        isRestart && previousSpawnAgeMs < SIDECAR_RESTART_COOLDOWN_MS
          ? SIDECAR_RESTART_COOLDOWN_MS - previousSpawnAgeMs
          : 0;
      if (cooldownMs > 0) {
        this.logger.info(
          `agent-control: sidecar restart backoff_ms=${cooldownMs} generation=${this.generation} restart_count=${this.restartCount} reason=${reason}`,
        );
        await sleepMs(cooldownMs);
      }
      if (this.stopped) {
        throw new Error("agent-control: sidecar startup cancelled because client is stopped");
      }

      const child = spawn(process.execPath, ["--import", "tsx", sidecarPath], {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
        },
      });
      this.lastSpawnAtMs = Date.now();
      this.generation += 1;
      if (this.generation > 1) {
        this.restartCount += 1;
      }
      const generation = this.generation;

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string | Buffer) => {
        this.handleStdoutChunk(
          generation,
          typeof chunk === "string" ? chunk : chunk.toString("utf8"),
        );
      });

      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string | Buffer) => {
        const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
        const trimmed = text.trim();
        if (trimmed.length > 0) {
          this.logger.warn(`agent-control: sidecar stderr: ${trimToMax(trimmed, 1000)}`);
        }
      });

      child.on("exit", (code, signal) => {
        this.handleProcessExit(generation, code, signal);
      });

      child.on("error", (error) => {
        this.logger.warn(
          `agent-control: sidecar process error generation=${generation}: ${describeError(error)}`,
        );
      });

      this.process = child;
      this.stdoutBuffer = "";
      this.logger.info(
        `agent-control: sidecar started pid=${child.pid ?? "unknown"} generation=${generation} restart_count=${this.restartCount} reason=${reason} start_sec=${secondsSince(startedAt)}`,
      );
      return child;
    })().finally(() => {
      if (this.startPromise === startPromise) {
        this.startPromise = null;
      }
    });

    this.startPromise = startPromise;
    return startPromise;
  }

  private handleProcessExit(
    generation: number,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (generation !== this.generation) {
      return;
    }
    if (this.process) {
      this.process = null;
    }
    this.stdoutBuffer = "";
    const queueDepth = this.queueDepth();
    const err = new Error(
      `agent-control: sidecar exited (code=${code ?? "null"} signal=${signal ?? "null"})`,
    );
    for (const [id, entry] of this.pending.entries()) {
      if (entry.generation !== generation) {
        continue;
      }
      this.pending.delete(id);
      if (entry.settled) {
        continue;
      }
      entry.settled = true;
      clearTimeout(entry.timeout);
      entry.reject(err);
    }
    this.logger.warn(
      `agent-control: sidecar exit generation=${generation} restart_count=${this.restartCount} queue_depth=${queueDepth} code=${code ?? "null"} signal=${signal ?? "null"}`,
    );
  }

  private handleStdoutChunk(generation: number, chunk: string) {
    if (generation !== this.generation) {
      return;
    }
    this.stdoutBuffer += chunk;
    while (true) {
      const newlineIndex = this.stdoutBuffer.indexOf("\n");
      if (newlineIndex === -1) {
        return;
      }
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line.length === 0) {
        continue;
      }
      this.handleStdoutLine(generation, line);
    }
  }

  private handleStdoutLine(generation: number, line: string) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.logger.warn(`agent-control: sidecar produced non-JSON output: ${trimToMax(line, 500)}`);
      return;
    }
    if (!parsed || typeof parsed !== "object") {
      this.logger.warn("agent-control: sidecar produced invalid message payload");
      return;
    }
    const message = parsed as {
      id?: unknown;
      ok?: unknown;
      result?: unknown;
      error?: unknown;
    };
    if (typeof message.id !== "number") {
      this.logger.warn("agent-control: sidecar response missing numeric id");
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }
    if (pending.generation !== generation || pending.settled) {
      return;
    }
    this.pending.delete(message.id);
    pending.settled = true;
    clearTimeout(pending.timeout);

    if (message.ok === true) {
      pending.resolve(message.result as SidecarToolCatalogResponse);
      return;
    }

    const errorMessage = typeof message.error === "string" ? message.error : "sidecar request failed";
    pending.reject(new Error(`agent-control: ${errorMessage}`));
  }

  private enqueueRequest<T>(work: () => Promise<T>): Promise<T> {
    this.queuedRequests += 1;
    const run = this.requestChain.then(work, work);
    this.requestChain = run.then(
      () => {
        this.queuedRequests = Math.max(0, this.queuedRequests - 1);
      },
      () => {
        this.queuedRequests = Math.max(0, this.queuedRequests - 1);
      },
    );
    return run;
  }

  private request(payload: SidecarRequestPayload): Promise<unknown> {
    return this.enqueueRequest(async () => {
      const child = await this.ensureRunning(payload.type);
      const generation = this.generation;
      const id = this.nextRequestId++;
      const message = JSON.stringify({
        id,
        type: payload.type,
        params: payload.params,
      });

      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          const pending = this.pending.get(id);
          if (!pending || pending.generation !== generation || pending.settled) {
            return;
          }
          this.pending.delete(id);
          pending.settled = true;
          reject(
            new Error(`agent-control: sidecar request timed out after ${SIDECAR_REQUEST_TIMEOUT_MS}ms`),
          );
        }, SIDECAR_REQUEST_TIMEOUT_MS);

        this.pending.set(id, {
          id,
          generation,
          type: payload.type,
          startedAt: process.hrtime.bigint(),
          settled: false,
          resolve,
          reject,
          timeout,
        });

        child.stdin.write(`${message}\n`, "utf8", (error) => {
          if (!error) {
            return;
          }
          const pending = this.pending.get(id);
          if (!pending || pending.generation !== generation || pending.settled) {
            return;
          }
          this.pending.delete(id);
          pending.settled = true;
          clearTimeout(pending.timeout);
          reject(new Error(`agent-control: failed to write sidecar request: ${describeError(error)}`));
        });
      });
    });
  }
}

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
      if (absolutePath.endsWith(".ts")) {
        return jiti(absolutePath) as Record<string, unknown>;
      }
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
      importOpenClawInternalModule(openClawRoot, [
        "dist/agents/pi-tools.js",
        "src/agents/pi-tools.ts",
      ]),
      importOpenClawInternalModule(openClawRoot, [
        "dist/agents/pi-tool-definition-adapter.js",
        "src/agents/pi-tool-definition-adapter.ts",
      ]),
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

async function loadSessionStoreInternals(): Promise<SessionStoreInternals> {
  if (sessionStoreInternalsPromise) {
    return sessionStoreInternalsPromise;
  }

  sessionStoreInternalsPromise = (async () => {
    const openClawRoot = resolveOpenClawRootDir();
    const [configModule, sessionsModule] = await Promise.all([
      importOpenClawInternalModule(openClawRoot, [
        "dist/config/config.js",
        "src/config/config.ts",
      ]),
      importOpenClawInternalModule(openClawRoot, [
        "dist/config/sessions.js",
        "src/config/sessions.ts",
      ]),
    ]);

    const loadConfig = configModule.loadConfig;
    const resolveStorePath = sessionsModule.resolveStorePath;
    const loadSessionStore = sessionsModule.loadSessionStore;

    if (typeof loadConfig !== "function") {
      throw new Error("agent-control: openclaw internal loadConfig is unavailable");
    }
    if (typeof resolveStorePath !== "function") {
      throw new Error("agent-control: openclaw internal resolveStorePath is unavailable");
    }
    if (typeof loadSessionStore !== "function") {
      throw new Error("agent-control: openclaw internal loadSessionStore is unavailable");
    }

    return {
      loadConfig: loadConfig as SessionStoreInternals["loadConfig"],
      resolveStorePath: resolveStorePath as SessionStoreInternals["resolveStorePath"],
      loadSessionStore: loadSessionStore as SessionStoreInternals["loadSessionStore"],
    };
  })();

  return sessionStoreInternalsPromise;
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

function secondsSince(startedAt: bigint): string {
  return (Number(process.hrtime.bigint() - startedAt) / 1_000_000_000).toFixed(3);
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

async function resolveStepsInProcess(params: {
  api: OpenClawPluginApi;
  sourceAgentId: string;
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
}): Promise<SidecarToolCatalogResponse> {
  const internalsStartedAt = process.hrtime.bigint();
  const internals = await loadToolCatalogInternals();
  const internalsDurationSec = secondsSince(internalsStartedAt);

  const createToolsStartedAt = process.hrtime.bigint();
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
  const createToolsDurationSec = secondsSince(createToolsStartedAt);

  const adaptStartedAt = process.hrtime.bigint();
  const toolDefinitions = internals.toToolDefinitions(tools);
  const steps = buildSteps(
    toolDefinitions.map((tool) => ({
      name: tool.name,
      label: tool.label,
      description: tool.description,
      parameters: tool.parameters,
    })),
  );
  const adaptDurationSec = secondsSince(adaptStartedAt);

  return {
    steps,
    internalsDurationSec,
    createToolsDurationSec,
    adaptDurationSec,
    toolsCount: tools.length,
  };
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

function unknownSessionIdentity(): SessionIdentitySnapshot {
  return {
    provider: null,
    type: "unknown",
    channelName: null,
    dmUserName: null,
    label: null,
    from: null,
    to: null,
    accountId: null,
    source: "unknown",
  };
}

function normalizeSessionStoreKey(sessionKey: string | undefined): string | undefined {
  const normalized = asString(sessionKey)?.toLowerCase();
  return normalized || undefined;
}

function resolveBaseSessionKey(sessionKey: string): string {
  const topicIndex = sessionKey.lastIndexOf(":topic:");
  const threadIndex = sessionKey.lastIndexOf(":thread:");
  const markerIndex = Math.max(topicIndex, threadIndex);
  if (markerIndex < 0) {
    return sessionKey;
  }
  const base = sessionKey.slice(0, markerIndex);
  return base || sessionKey;
}

function readSessionIdentityFromEntry(entry: Record<string, unknown>): SessionIdentitySnapshot {
  const origin = isRecord(entry.origin) ? entry.origin : undefined;
  const deliveryContext = isRecord(entry.deliveryContext) ? entry.deliveryContext : undefined;

  const rawType = asString(origin?.chatType);
  const type: ChannelType =
    rawType === "direct" || rawType === "group" || rawType === "channel" ? rawType : "unknown";

  const label = asString(origin?.label) ?? null;
  const provider =
    asString(origin?.provider) ??
    asString(entry.channel) ??
    asString(deliveryContext?.channel) ??
    null;

  const channelName =
    asString(entry.groupChannel) ??
    asString(entry.subject) ??
    (type !== "direct" ? label : undefined) ??
    null;

  const dmUserName = type === "direct" ? label ?? asString(entry.displayName) ?? null : null;

  return {
    provider,
    type,
    channelName,
    dmUserName,
    label,
    from: asString(origin?.from) ?? null,
    to: asString(origin?.to) ?? asString(deliveryContext?.to) ?? null,
    accountId:
      asString(origin?.accountId) ??
      asString(deliveryContext?.accountId) ??
      asString(entry.lastAccountId) ??
      null,
    source: "sessionStore",
  };
}

function setSessionMetadataCache(key: string, data: SessionIdentitySnapshot): void {
  sessionMetadataCache.set(key, { at: Date.now(), data });
  if (sessionMetadataCache.size > SESSION_META_CACHE_MAX) {
    const oldest = sessionMetadataCache.keys().next().value;
    if (typeof oldest === "string") {
      sessionMetadataCache.delete(oldest);
    }
  }
}

async function resolveSessionIdentity(sessionKey: string | undefined): Promise<SessionIdentitySnapshot> {
  const normalizedKey = normalizeSessionStoreKey(sessionKey);
  if (!normalizedKey) {
    return unknownSessionIdentity();
  }

  const cached = sessionMetadataCache.get(normalizedKey);
  if (cached && Date.now() - cached.at < SESSION_META_CACHE_TTL_MS) {
    return cached.data;
  }

  try {
    const internals = await loadSessionStoreInternals();
    const cfg = internals.loadConfig();
    const sessionCfg = isRecord(cfg.session) ? cfg.session : undefined;
    const storePath = internals.resolveStorePath(asString(sessionCfg?.store));
    const store = internals.loadSessionStore(storePath);
    const entry =
      (isRecord(store[normalizedKey]) ? store[normalizedKey] : undefined) ??
      (isRecord(store[resolveBaseSessionKey(normalizedKey)])
        ? store[resolveBaseSessionKey(normalizedKey)]
        : undefined);
    const data = entry ? readSessionIdentityFromEntry(entry) : unknownSessionIdentity();
    setSessionMetadataCache(normalizedKey, data);
    return data;
  } catch {
    return unknownSessionIdentity();
  }
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
  api.logger.info(
    `agent-control: client_init duration_sec=${secondsSince(clientInitStartedAt)} timeout_ms=${clientTimeoutMs ?? "default"} server_url=${serverUrl}`,
  );

  let sidecar: ToolSchemaSidecarClient | null = null;
  let oneShotFallbackUsed = false;
  const prewarmSidecar = async (trigger: "register" | "gateway_start"): Promise<void> => {
    if (!sidecar) {
      return;
    }
    const deduped = sidecar.isPrewarmInFlight();
    const prewarmStartedAt = process.hrtime.bigint();
    try {
      await sidecar.prewarm();
      api.logger.info(
        `agent-control: sidecar prewarm trigger=${trigger} deduped=${deduped} duration_sec=${secondsSince(prewarmStartedAt)} openclaw_root=${sidecar.getOpenClawRoot()}`,
      );
    } catch (error) {
      api.logger.warn(
        `agent-control: sidecar prewarm trigger=${trigger} deduped=${deduped} failed=${describeError(error)}`,
      );
    }
  };
  try {
    const openClawRoot = resolveOpenClawRootDir();
    sidecar = new ToolSchemaSidecarClient(openClawRoot, api.logger);
    void prewarmSidecar("register");
    process.once("beforeExit", () => {
      sidecar?.stop("process_beforeExit");
    });
    process.once("exit", () => {
      sidecar?.stop("process_exit");
    });
  } catch (error) {
    api.logger.warn(`agent-control: sidecar disabled: ${describeError(error)}`);
  }

  api.on("gateway_start", async () => {
    await prewarmSidecar("gateway_start");
  });
  api.on("gateway_stop", async () => {
    sidecar?.stop("gateway_stop");
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

  const buildEvaluationContext = async (params: {
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
  }): Promise<Record<string, unknown>> => {
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
        id: api.id,
        version: pluginVersion ?? null,
      },
      policy: {
        failClosed,
        configuredAgentId: configuredAgentId ?? null,
        configuredAgentVersion: configuredAgentVersion ?? null,
      },
      sync: {
        agentName: params.state.agentName,
        stepCount: params.state.steps.length,
        stepsHash: params.state.stepsHash,
        lastSyncedStepsHash: params.state.lastSyncedStepsHash,
      },
    };
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
      const beforeToolCallStartedAt = process.hrtime.bigint();
      const sourceAgentId = resolveSourceAgentId(ctx.agentId);
      const state = getOrCreateState(sourceAgentId);
      const argsForLog = formatToolArgsForLog(event.params);
      api.logger.info(
        `agent-control: before_tool_call entered agent=${sourceAgentId} tool=${event.toolName} args=${argsForLog}`,
      );

      try {
        try {
          const resolveStepsStartedAt = process.hrtime.bigint();
          let resolveMode: "sidecar" | "cache" | "jiti_fallback_once" | "degraded_no_cache" =
            "degraded_no_cache";
          let sidecarError: string | null = null;
          let nextSteps: AgentControlStep[] | null = null;

          if (sidecar) {
            try {
              const safeConfig = toJsonRecord(api.config) ?? {};
              const sidecarResult = await sidecar.resolveSteps({
                sourceAgentId,
                sessionKey: ctx.sessionKey,
                sessionId: ctx.sessionId,
                runId: ctx.runId,
                config: safeConfig,
              });
              nextSteps = sidecarResult.steps;
              resolveMode = "sidecar";
              api.logger.info(
                `agent-control: resolve_steps mode=sidecar duration_sec=${secondsSince(resolveStepsStartedAt)} agent=${sourceAgentId} tool=${event.toolName} internals_sec=${sidecarResult.internalsDurationSec} create_tools_sec=${sidecarResult.createToolsDurationSec} adapt_sec=${sidecarResult.adaptDurationSec} tools=${sidecarResult.toolsCount} steps=${sidecarResult.steps.length}`,
              );
            } catch (error) {
              sidecarError = describeError(error);
            }
          } else {
            sidecarError = "sidecar unavailable";
          }

          if (!nextSteps) {
            if (state.steps.length > 0) {
              nextSteps = state.steps;
              resolveMode = "cache";
              api.logger.warn(
                `agent-control: resolve_steps mode=cache duration_sec=${secondsSince(resolveStepsStartedAt)} agent=${sourceAgentId} tool=${event.toolName} cached_steps=${state.steps.length} sidecar_error=${sidecarError ?? "unknown"}`,
              );
            } else if (!oneShotFallbackUsed) {
              oneShotFallbackUsed = true;
              try {
                const fallbackResult = await resolveStepsInProcess({
                  api,
                  sourceAgentId,
                  sessionKey: ctx.sessionKey,
                  sessionId: ctx.sessionId,
                  runId: ctx.runId,
                });
                nextSteps = fallbackResult.steps;
                resolveMode = "jiti_fallback_once";
                api.logger.warn(
                  `agent-control: resolve_steps mode=jiti_fallback_once duration_sec=${secondsSince(resolveStepsStartedAt)} agent=${sourceAgentId} tool=${event.toolName} internals_sec=${fallbackResult.internalsDurationSec} create_tools_sec=${fallbackResult.createToolsDurationSec} adapt_sec=${fallbackResult.adaptDurationSec} tools=${fallbackResult.toolsCount} steps=${fallbackResult.steps.length} sidecar_error=${sidecarError ?? "unknown"}`,
                );
              } catch (fallbackError) {
                sidecarError = `sidecar=${sidecarError ?? "unknown"} jiti=${describeError(fallbackError)}`;
              }
            }
          }

          if (!nextSteps) {
            resolveMode = "degraded_no_cache";
            api.logger.warn(
              `agent-control: resolve_steps mode=degraded_no_cache duration_sec=${secondsSince(resolveStepsStartedAt)} agent=${sourceAgentId} tool=${event.toolName} one_shot_fallback_used=${oneShotFallbackUsed} reason=${sidecarError ?? "unknown"}`,
            );
          } else {
            const nextStepsHash = hashSteps(nextSteps);
            if (nextStepsHash !== state.stepsHash) {
              state.steps = nextSteps;
              state.stepsHash = nextStepsHash;
            }
          }
          api.logger.info(
            `agent-control: before_tool_call phase=resolve_steps mode=${resolveMode} duration_sec=${secondsSince(resolveStepsStartedAt)} agent=${sourceAgentId} tool=${event.toolName} steps=${state.steps.length}`,
          );

          if (state.steps.length > 0) {
            const syncStartedAt = process.hrtime.bigint();
            await syncAgent(state);
            api.logger.info(
              `agent-control: before_tool_call phase=sync_agent duration_sec=${secondsSince(syncStartedAt)} agent=${sourceAgentId} tool=${event.toolName} step_count=${state.steps.length}`,
            );
          } else {
            api.logger.info(
              `agent-control: before_tool_call phase=sync_agent skipped=true reason=no_steps mode=degraded_no_cache agent=${sourceAgentId} tool=${event.toolName}`,
            );
          }
        } catch (err) {
          api.logger.warn(
            `agent-control: unable to sync agent=${sourceAgentId} before tool evaluation: ${String(err)}`,
          );
          if (failClosed) {
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
          });
          api.logger.info(
            `agent-control: before_tool_call phase=build_context duration_sec=${secondsSince(contextBuildStartedAt)} agent=${sourceAgentId} tool=${event.toolName}`,
          );

          api.logger.info(
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
          api.logger.info(
            `agent-control: before_tool_call phase=evaluate duration_sec=${secondsSince(evaluateStartedAt)} agent=${sourceAgentId} tool=${event.toolName} safe=${evaluation.isSafe}`,
          );

          if (evaluation.isSafe) {
            api.logger.info("safe !");
            return;
          }

          api.logger.info("unsafe !");
          api.logger.warn(
            `agent-control: blocked tool=${event.toolName} agent=${sourceAgentId} reason=${buildBlockReason(evaluation)}`,
          );

          return {
            block: true,
            blockReason: USER_BLOCK_MESSAGE,
          };
        } catch (err) {
          api.logger.warn(
            `agent-control: evaluation failed for agent=${sourceAgentId} tool=${event.toolName}: ${String(err)}`,
          );
          if (failClosed) {
            return {
              block: true,
              blockReason: USER_BLOCK_MESSAGE,
            };
          }
        }
      } finally {
        api.logger.info(
          `agent-control: before_tool_call duration_sec=${secondsSince(beforeToolCallStartedAt)} agent=${sourceAgentId} tool=${event.toolName}`,
        );
      }
    },
    { priority: 100 },
  );
}
