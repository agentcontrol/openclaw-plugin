import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createJiti } from "jiti";

const requireFromPlugin = createRequire(import.meta.url);
const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".json"],
});

export const PLUGIN_ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));

let resolvedOpenClawRootDir: string | null = null;

function readPackageField(packageJsonPath: string, field: "name" | "version"): string | undefined {
  try {
    const raw = fs.readFileSync(packageJsonPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return undefined;
    }
    const value = (parsed as { name?: unknown; version?: unknown })[field];
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

export function readPackageName(packageJsonPath: string): string | undefined {
  return readPackageField(packageJsonPath, "name");
}

export function readPackageVersion(packageJsonPath: string): string | undefined {
  return readPackageField(packageJsonPath, "version");
}

export function safeStatMtimeMs(filePath: string): number | null {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
}

export function normalizeRelativeImportPath(fromDir: string, toFile: string): string {
  const relativePath = path.relative(fromDir, toFile).replaceAll(path.sep, "/");
  if (relativePath.startsWith(".")) {
    return relativePath;
  }
  return `./${relativePath}`;
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

export function getResolvedOpenClawRootDir(): string {
  if (!resolvedOpenClawRootDir) {
    resolvedOpenClawRootDir = resolveOpenClawRootDir();
  }
  return resolvedOpenClawRootDir;
}

export async function tryImportOpenClawInternalModule(
  openClawRoot: string,
  candidates: string[],
): Promise<Record<string, unknown> | null> {
  for (const relativePath of candidates) {
    const absolutePath = path.join(openClawRoot, relativePath);
    if (!fs.existsSync(absolutePath)) {
      continue;
    }
    try {
      return (await import(pathToFileURL(absolutePath).href)) as Record<string, unknown>;
    } catch {
      continue;
    }
  }
  return null;
}

export async function importOpenClawInternalModule(
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
