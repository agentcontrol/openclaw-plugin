import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

type AgentControlStep = {
  type: "tool";
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

type ToolCatalogInternals = {
  createOpenClawCodingTools: (params: {
    agentId: string;
    sessionKey?: string;
    sessionId?: string;
    runId?: string;
    config: Record<string, unknown>;
    senderIsOwner: boolean;
  }) => unknown[];
  toToolDefinitions: (tools: unknown[]) => Array<{
    name: string;
    label?: string;
    description?: string;
    parameters?: unknown;
  }>;
};

type ResolveStepsPayload = {
  openClawRoot: string;
  sourceAgentId: string;
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  config?: Record<string, unknown>;
};

type SidecarRequest = {
  id: number;
  type: "prewarm" | "resolve_steps";
  params: Record<string, unknown>;
};

type SidecarResponse = {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
};

const toolCatalogInternalsByRoot = new Map<string, Promise<ToolCatalogInternals>>();

function secondsSince(startedAt: bigint): string {
  return (Number(process.hrtime.bigint() - startedAt) / 1_000_000_000).toFixed(3);
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
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

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message || String(error);
  }
  return String(error);
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
    } catch (error) {
      lastErr = error;
    }
  }
  throw (
    lastErr ??
    new Error(
      `agent-control sidecar: openclaw internal module not found (${candidates.join(", ")}) under ${openClawRoot}`,
    )
  );
}

async function loadToolCatalogInternals(openClawRoot: string): Promise<ToolCatalogInternals> {
  const existing = toolCatalogInternalsByRoot.get(openClawRoot);
  if (existing) {
    return existing;
  }

  const created = (async () => {
    const [piToolsModule, adapterModule] = await Promise.all([
      importOpenClawInternalModule(openClawRoot, ["dist/agents/pi-tools.js", "src/agents/pi-tools.ts"]),
      importOpenClawInternalModule(openClawRoot, [
        "dist/agents/pi-tool-definition-adapter.js",
        "src/agents/pi-tool-definition-adapter.ts",
      ]),
    ]);

    const createOpenClawCodingTools = piToolsModule.createOpenClawCodingTools;
    const toToolDefinitions = adapterModule.toToolDefinitions;

    if (typeof createOpenClawCodingTools !== "function") {
      throw new Error("agent-control sidecar: createOpenClawCodingTools is unavailable");
    }
    if (typeof toToolDefinitions !== "function") {
      throw new Error("agent-control sidecar: toToolDefinitions is unavailable");
    }

    return {
      createOpenClawCodingTools: createOpenClawCodingTools as ToolCatalogInternals["createOpenClawCodingTools"],
      toToolDefinitions: toToolDefinitions as ToolCatalogInternals["toToolDefinitions"],
    };
  })();

  toolCatalogInternalsByRoot.set(openClawRoot, created);
  return created;
}

async function handlePrewarm(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const openClawRoot = asString(params.openClawRoot);
  if (!openClawRoot) {
    throw new Error("agent-control sidecar: prewarm missing openClawRoot");
  }
  const startedAt = process.hrtime.bigint();
  await loadToolCatalogInternals(openClawRoot);
  return {
    durationSec: secondsSince(startedAt),
  };
}

async function handleResolveSteps(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const payload = params as unknown as ResolveStepsPayload;
  const openClawRoot = asString(payload.openClawRoot);
  if (!openClawRoot) {
    throw new Error("agent-control sidecar: resolve_steps missing openClawRoot");
  }
  const sourceAgentId = asString(payload.sourceAgentId);
  if (!sourceAgentId) {
    throw new Error("agent-control sidecar: resolve_steps missing sourceAgentId");
  }

  const internalsStartedAt = process.hrtime.bigint();
  const internals = await loadToolCatalogInternals(openClawRoot);
  const internalsDurationSec = secondsSince(internalsStartedAt);

  const createToolsStartedAt = process.hrtime.bigint();
  const tools = internals.createOpenClawCodingTools({
    agentId: sourceAgentId,
    sessionKey: asString(payload.sessionKey),
    sessionId: asString(payload.sessionId),
    runId: asString(payload.runId),
    config: toJsonRecord(payload.config) ?? {},
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

async function handleRequest(request: SidecarRequest): Promise<unknown> {
  if (request.type === "prewarm") {
    return handlePrewarm(request.params);
  }
  if (request.type === "resolve_steps") {
    return handleResolveSteps(request.params);
  }
  throw new Error(`agent-control sidecar: unsupported request type ${String(request.type)}`);
}

function writeResponse(response: SidecarResponse) {
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

function parseRequest(line: string): SidecarRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error("agent-control sidecar: input is not valid JSON");
  }
  if (!isRecord(parsed)) {
    throw new Error("agent-control sidecar: request must be an object");
  }
  const id = parsed.id;
  const type = parsed.type;
  const params = parsed.params;
  if (typeof id !== "number") {
    throw new Error("agent-control sidecar: request.id must be a number");
  }
  if (type !== "prewarm" && type !== "resolve_steps") {
    throw new Error("agent-control sidecar: request.type must be prewarm or resolve_steps");
  }
  if (!isRecord(params)) {
    throw new Error("agent-control sidecar: request.params must be an object");
  }
  return {
    id,
    type,
    params,
  };
}

function handleInputLine(line: string) {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return;
  }

  let request: SidecarRequest;
  try {
    request = parseRequest(trimmed);
  } catch (error) {
    writeResponse({
      id: -1,
      ok: false,
      error: describeError(error),
    });
    return;
  }

  queueRequest(request);
}

async function runRequest(request: SidecarRequest): Promise<void> {
  try {
    const result = await handleRequest(request);
    writeResponse({
      id: request.id,
      ok: true,
      result,
    });
  } catch (error) {
    writeResponse({
      id: request.id,
      ok: false,
      error: describeError(error),
    });
  }
}

process.stdin.setEncoding("utf8");

let requestChain: Promise<void> = Promise.resolve();
function queueRequest(request: SidecarRequest): void {
  const next = requestChain.then(
    () => runRequest(request),
    () => runRequest(request),
  );
  requestChain = next;
}

let inputBuffer = "";
process.stdin.on("data", (chunk: string | Buffer) => {
  inputBuffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");

  while (true) {
    const newlineIndex = inputBuffer.indexOf("\n");
    if (newlineIndex === -1) {
      break;
    }
    const line = inputBuffer.slice(0, newlineIndex);
    inputBuffer = inputBuffer.slice(newlineIndex + 1);
    handleInputLine(line);
  }
});

process.stdin.on("end", () => {
  process.exit(0);
});

process.on("uncaughtException", (error) => {
  process.stderr.write(`agent-control sidecar uncaughtException: ${describeError(error)}\n`);
});

process.on("unhandledRejection", (reason) => {
  process.stderr.write(`agent-control sidecar unhandledRejection: ${describeError(reason)}\n`);
});
