import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentControlStep, LoggerLike, ResolveStepsForContextParams, ToolCatalogBundleBuildInfo, ToolCatalogInternals } from "./types.ts";
import { asString, sanitizeToolCatalogConfig, secondsSince, toJsonRecord } from "./shared.ts";
import {
  getResolvedOpenClawRootDir,
  importOpenClawInternalModule,
  normalizeRelativeImportPath,
  PLUGIN_ROOT_DIR,
  readPackageVersion,
  safeStatMtimeMs,
  tryImportOpenClawInternalModule,
} from "./openclaw-runtime.ts";

const TOOL_CATALOG_BUNDLE_DIRNAME = path.join("dist", "agent-control-generated", "tool-catalog");
const TOOL_CATALOG_BUNDLE_FILE = "index.mjs";
const TOOL_CATALOG_WRAPPER_FILE = "entry.ts";

let toolCatalogInternalsPromise: Promise<ToolCatalogInternals> | null = null;

function resolveToolCatalogBundleBuildInfo(openClawRoot: string): ToolCatalogBundleBuildInfo {
  const piToolsSource = path.join(openClawRoot, "src/agents/pi-tools.ts");
  const adapterSource = path.join(openClawRoot, "src/agents/pi-tool-definition-adapter.ts");
  const cacheKeySeed = JSON.stringify({
    openClawRoot,
    openClawVersion: readPackageVersion(path.join(openClawRoot, "package.json")) ?? "unknown",
    pluginVersion: readPackageVersion(path.join(PLUGIN_ROOT_DIR, "..", "package.json")) ?? "unknown",
    nodeMajor: process.versions.node.split(".")[0] ?? "unknown",
    piToolsMtimeMs: safeStatMtimeMs(piToolsSource),
    adapterMtimeMs: safeStatMtimeMs(adapterSource),
  });
  const cacheKey = createHash("sha256").update(cacheKeySeed).digest("hex").slice(0, 16);
  const cacheDir = path.join(openClawRoot, TOOL_CATALOG_BUNDLE_DIRNAME, cacheKey);
  return {
    bundlePath: path.join(cacheDir, TOOL_CATALOG_BUNDLE_FILE),
    cacheDir,
    cacheKey,
    openClawRoot,
    wrapperEntryPath: path.join(cacheDir, TOOL_CATALOG_WRAPPER_FILE),
    metaPath: path.join(cacheDir, "meta.json"),
  };
}

function hasToolCatalogBundleSources(openClawRoot: string): boolean {
  return (
    fs.existsSync(path.join(openClawRoot, "src/agents/pi-tools.ts")) &&
    fs.existsSync(path.join(openClawRoot, "src/agents/pi-tool-definition-adapter.ts"))
  );
}

async function importToolCatalogBundleModule(
  logger: LoggerLike,
  buildInfo: ToolCatalogBundleBuildInfo,
): Promise<Record<string, unknown>> {
  const importStartedAt = process.hrtime.bigint();
  const bundleMtime = safeStatMtimeMs(buildInfo.bundlePath) ?? Date.now();
  const bundleUrl = `${pathToFileURL(buildInfo.bundlePath).href}?mtime=${bundleMtime}`;
  const imported = (await import(bundleUrl)) as Record<string, unknown>;
  logger.info(
    `agent-control: bundle_import_done duration_sec=${secondsSince(importStartedAt)} cache_key=${buildInfo.cacheKey} bundle_path=${buildInfo.bundlePath}`,
  );
  return imported;
}

function resolveToolCatalogInternalsFromModules(params: {
  adapterModule: Record<string, unknown>;
  piToolsModule: Record<string, unknown>;
}): ToolCatalogInternals {
  const createOpenClawCodingTools = params.piToolsModule.createOpenClawCodingTools;
  const toToolDefinitions = params.adapterModule.toToolDefinitions;
  if (typeof createOpenClawCodingTools !== "function") {
    throw new Error("agent-control: openclaw internal createOpenClawCodingTools is unavailable");
  }
  if (typeof toToolDefinitions !== "function") {
    throw new Error("agent-control: openclaw internal toToolDefinitions is unavailable");
  }

  return {
    createOpenClawCodingTools:
      createOpenClawCodingTools as ToolCatalogInternals["createOpenClawCodingTools"],
    toToolDefinitions: toToolDefinitions as ToolCatalogInternals["toToolDefinitions"],
  };
}

async function ensureToolCatalogBundle(
  logger: LoggerLike,
  buildInfo: ToolCatalogBundleBuildInfo,
): Promise<void> {
  if (fs.existsSync(buildInfo.bundlePath)) {
    logger.info(
      `agent-control: bundle_cache_hit cache_key=${buildInfo.cacheKey} bundle_path=${buildInfo.bundlePath}`,
    );
    return;
  }

  const esbuildStartedAt = process.hrtime.bigint();
  logger.info(
    `agent-control: bundle_build_started cache_key=${buildInfo.cacheKey} openclaw_root=${buildInfo.openClawRoot}`,
  );

  let esbuild: {
    build: (options: Record<string, unknown>) => Promise<unknown>;
  };
  try {
    esbuild = (await import("esbuild")) as {
      build: (options: Record<string, unknown>) => Promise<unknown>;
    };
  } catch (err) {
    throw new Error(`agent-control: esbuild is unavailable: ${String(err)}`);
  }

  fs.mkdirSync(buildInfo.cacheDir, { recursive: true });
  const piToolsSource = path.join(buildInfo.openClawRoot, "src/agents/pi-tools.ts");
  const adapterSource = path.join(buildInfo.openClawRoot, "src/agents/pi-tool-definition-adapter.ts");
  const wrapperContents = [
    `export { createOpenClawCodingTools } from ${JSON.stringify(normalizeRelativeImportPath(buildInfo.cacheDir, piToolsSource))};`,
    `export { toToolDefinitions } from ${JSON.stringify(normalizeRelativeImportPath(buildInfo.cacheDir, adapterSource))};`,
    "",
  ].join("\n");
  fs.writeFileSync(buildInfo.wrapperEntryPath, wrapperContents, "utf8");

  const tsconfigPath = path.join(buildInfo.openClawRoot, "tsconfig.json");
  try {
    await esbuild.build({
      absWorkingDir: buildInfo.openClawRoot,
      bundle: true,
      entryPoints: [buildInfo.wrapperEntryPath],
      format: "esm",
      logLevel: "silent",
      outfile: buildInfo.bundlePath,
      packages: "external",
      platform: "node",
      target: [`node${process.versions.node}`],
      tsconfig: fs.existsSync(tsconfigPath) ? tsconfigPath : undefined,
      write: true,
    });
  } catch (err) {
    fs.rmSync(buildInfo.cacheDir, { force: true, recursive: true });
    throw err;
  }

  fs.writeFileSync(
    buildInfo.metaPath,
    `${JSON.stringify(
      {
        builtAt: new Date().toISOString(),
        cacheKey: buildInfo.cacheKey,
        bundlePath: buildInfo.bundlePath,
        openClawRoot: buildInfo.openClawRoot,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  logger.info(
    `agent-control: bundle_build_done duration_sec=${secondsSince(esbuildStartedAt)} cache_key=${buildInfo.cacheKey} bundle_path=${buildInfo.bundlePath}`,
  );
}

async function loadToolCatalogInternalsFromGeneratedBundle(
  logger: LoggerLike,
  openClawRoot: string,
): Promise<ToolCatalogInternals | null> {
  if (!hasToolCatalogBundleSources(openClawRoot)) {
    return null;
  }

  const buildInfo = resolveToolCatalogBundleBuildInfo(openClawRoot);
  const hadBundle = fs.existsSync(buildInfo.bundlePath);
  try {
    await ensureToolCatalogBundle(logger, buildInfo);
    const bundledModule = await importToolCatalogBundleModule(logger, buildInfo);
    return resolveToolCatalogInternalsFromModules({
      adapterModule: bundledModule,
      piToolsModule: bundledModule,
    });
  } catch (err) {
    if (hadBundle) {
      logger.warn(
        `agent-control: bundle_import_failed cache_key=${buildInfo.cacheKey} bundle_path=${buildInfo.bundlePath} error=${String(err)}`,
      );
      fs.rmSync(buildInfo.cacheDir, { force: true, recursive: true });
      await ensureToolCatalogBundle(logger, buildInfo);
      const rebuiltModule = await importToolCatalogBundleModule(logger, buildInfo);
      return resolveToolCatalogInternalsFromModules({
        adapterModule: rebuiltModule,
        piToolsModule: rebuiltModule,
      });
    }
    throw err;
  }
}

async function loadToolCatalogInternals(logger: LoggerLike): Promise<ToolCatalogInternals> {
  if (toolCatalogInternalsPromise) {
    return toolCatalogInternalsPromise;
  }

  toolCatalogInternalsPromise = (async () => {
    const openClawRoot = getResolvedOpenClawRootDir();
    const [distPiToolsModule, distAdapterModule] = await Promise.all([
      tryImportOpenClawInternalModule(openClawRoot, [
        "dist/agents/pi-tools.js",
        "dist/agents/pi-tools.mjs",
      ]),
      tryImportOpenClawInternalModule(openClawRoot, [
        "dist/agents/pi-tool-definition-adapter.js",
        "dist/agents/pi-tool-definition-adapter.mjs",
      ]),
    ]);
    if (distPiToolsModule && distAdapterModule) {
      logger.info(`agent-control: tool_catalog_internals source=dist openclaw_root=${openClawRoot}`);
      return resolveToolCatalogInternalsFromModules({
        adapterModule: distAdapterModule,
        piToolsModule: distPiToolsModule,
      });
    }

    try {
      const bundledInternals = await loadToolCatalogInternalsFromGeneratedBundle(logger, openClawRoot);
      if (bundledInternals) {
        logger.info(
          `agent-control: tool_catalog_internals source=generated_bundle openclaw_root=${openClawRoot}`,
        );
        return bundledInternals;
      }
    } catch (err) {
      logger.warn(
        `agent-control: bundle_fallback=jiti openclaw_root=${openClawRoot} error=${String(err)}`,
      );
    }

    logger.info(`agent-control: tool_catalog_internals source=jiti openclaw_root=${openClawRoot}`);
    const [piToolsModule, adapterModule] = await Promise.all([
      importOpenClawInternalModule(openClawRoot, ["src/agents/pi-tools.ts"]),
      importOpenClawInternalModule(openClawRoot, ["src/agents/pi-tool-definition-adapter.ts"]),
    ]);

    return resolveToolCatalogInternalsFromModules({
      adapterModule,
      piToolsModule,
    });
  })();

  return toolCatalogInternalsPromise;
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

export async function resolveStepsForContext(
  params: ResolveStepsForContextParams,
): Promise<AgentControlStep[]> {
  const resolveStartedAt = process.hrtime.bigint();
  const internalsStartedAt = process.hrtime.bigint();
  const internals = await loadToolCatalogInternals(params.api.logger);
  const internalsDurationSec = secondsSince(internalsStartedAt);

  const createToolsStartedAt = process.hrtime.bigint();
  const tools = internals.createOpenClawCodingTools({
    agentId: params.sourceAgentId,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    runId: params.runId,
    config: sanitizeToolCatalogConfig(toJsonRecord(params.api.config) ?? {}),
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

  params.api.logger.info(
    `agent-control: resolve_steps duration_sec=${secondsSince(resolveStartedAt)} agent=${params.sourceAgentId} internals_sec=${internalsDurationSec} create_tools_sec=${createToolsDurationSec} adapt_sec=${adaptDurationSec} tools=${tools.length} steps=${steps.length}`,
  );

  return steps;
}
