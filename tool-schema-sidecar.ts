import fs from "node:fs";
import path from "node:path";
import { createJiti } from "jiti";

const SIDECAR_OPENCLAW_ROOT_ENV = "AGENT_CONTROL_OPENCLAW_ROOT";
const SIDECAR_JITI_CACHE_DIR_ENV = "AGENT_CONTROL_JITI_CACHE_DIR";
const JITI_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".json"];

type PrewarmTarget = {
  name: string;
  candidates: string[];
};

const PREWARM_TARGETS: PrewarmTarget[] = [
  {
    name: "pi-tools",
    candidates: ["dist/agents/pi-tools.js", "src/agents/pi-tools.ts"],
  },
  {
    name: "pi-tool-definition-adapter",
    candidates: [
      "dist/agents/pi-tool-definition-adapter.js",
      "src/agents/pi-tool-definition-adapter.ts",
    ],
  },
  {
    name: "config",
    candidates: ["dist/config/config.js", "src/config/config.ts"],
  },
  {
    name: "sessions",
    candidates: ["dist/config/sessions.js", "src/config/sessions.ts"],
  },
];

function secondsSince(startedAt: bigint): string {
  return (Number(process.hrtime.bigint() - startedAt) / 1_000_000_000).toFixed(3);
}

function isTypeScriptSourcePath(filePath: string): boolean {
  return (
    filePath.endsWith(".ts") ||
    filePath.endsWith(".tsx") ||
    filePath.endsWith(".mts") ||
    filePath.endsWith(".cts")
  );
}

function resolveEnvPath(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`agent-control sidecar: missing required env ${name}`);
  }
  return value;
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message || String(error);
  }
  return String(error);
}

function resolveExistingCandidate(openClawRoot: string, candidates: string[]): string {
  for (const candidate of candidates) {
    const absolutePath = path.join(openClawRoot, candidate);
    if (fs.existsSync(absolutePath)) {
      return absolutePath;
    }
  }
  throw new Error(
    `agent-control sidecar: openclaw internal module not found (${candidates.join(", ")}) under ${openClawRoot}`,
  );
}

async function main(): Promise<void> {
  const openClawRoot = resolveEnvPath(SIDECAR_OPENCLAW_ROOT_ENV);
  const cacheDir = resolveEnvPath(SIDECAR_JITI_CACHE_DIR_ENV);

  fs.mkdirSync(cacheDir, { recursive: true });

  const jiti = createJiti(import.meta.url, {
    interopDefault: true,
    extensions: JITI_EXTENSIONS,
    fsCache: cacheDir,
  });

  console.log(
    `prewarm_start openclaw_root=${openClawRoot} cache_dir=${cacheDir} targets=${PREWARM_TARGETS.length}`,
  );

  for (const target of PREWARM_TARGETS) {
    const startedAt = process.hrtime.bigint();
    const absolutePath = resolveExistingCandidate(openClawRoot, target.candidates);
    const relativePath = path.relative(openClawRoot, absolutePath) || absolutePath;

    if (!isTypeScriptSourcePath(absolutePath)) {
      console.log(
        `prewarm_target name=${target.name} mode=skip_dist duration_sec=${secondsSince(startedAt)} path=${relativePath}`,
      );
      continue;
    }

    jiti(absolutePath);
    console.log(
      `prewarm_target name=${target.name} mode=jiti duration_sec=${secondsSince(startedAt)} path=${relativePath}`,
    );
  }

  console.log(`prewarm_done openclaw_root=${openClawRoot} cache_dir=${cacheDir}`);
}

main().catch((error) => {
  console.error(`agent-control sidecar: ${describeError(error)}`);
  process.exitCode = 1;
});
