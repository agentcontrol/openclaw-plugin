import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const originalCwd = process.cwd();

async function loadRuntimeModule(options: { packageResolve?: string | Error } = {}) {
  vi.resetModules();
  vi.doMock("node:module", () => ({
    createRequire: () => ({
      resolve: () => {
        if (options.packageResolve instanceof Error) {
          throw options.packageResolve;
        }
        if (typeof options.packageResolve === "string") {
          return options.packageResolve;
        }
        throw new Error("openclaw package.json was not found");
      },
    }),
  }));
  return import("../src/openclaw-runtime.ts");
}

afterEach(() => {
  process.chdir(originalCwd);
  vi.doUnmock("node:module");
  vi.doUnmock("../src/openclaw-runtime.ts");
});

describe("openclaw runtime helpers", () => {
  it("reads the package name and version from package.json", async () => {
    // Given a package.json file with explicit name and version fields
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-runtime-pkg-"));
    const packageJsonPath = path.join(tempDir, "package.json");
    fs.writeFileSync(
      packageJsonPath,
      JSON.stringify({ name: "openclaw", version: "1.2.3" }),
      "utf8",
    );

    const runtime = await loadRuntimeModule();

    // When package metadata is read from that file
    const name = runtime.readPackageName(packageJsonPath);
    const version = runtime.readPackageVersion(packageJsonPath);

    // Then the declared package name and version are returned
    expect(name).toBe("openclaw");
    expect(version).toBe("1.2.3");
  });

  it("normalizes relative import paths with a leading dot", async () => {
    // Given a runtime helper and source and target files in sibling and same directories
    const runtime = await loadRuntimeModule();

    // When relative import paths are normalized
    const siblingImport = runtime.normalizeRelativeImportPath("/tmp/a/b", "/tmp/a/c/tool.ts");
    const sameDirImport = runtime.normalizeRelativeImportPath("/tmp/a/b", "/tmp/a/b/tool.ts");

    // Then each result uses a relative posix path with a leading dot
    expect(siblingImport).toBe("../c/tool.ts");
    expect(sameDirImport).toBe("./tool.ts");
  });

  it("finds the OpenClaw root from cwd when package resolution is unavailable", async () => {
    // Given package resolution failure and a cwd nested under an OpenClaw checkout
    const openClawRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-root-"));
    fs.writeFileSync(
      path.join(openClawRoot, "package.json"),
      JSON.stringify({ name: "openclaw" }),
      "utf8",
    );
    const nestedDir = path.join(openClawRoot, "src", "agents");
    fs.mkdirSync(nestedDir, { recursive: true });
    process.chdir(nestedDir);

    const runtime = await loadRuntimeModule({
      packageResolve: new Error("not found"),
    });

    // When the OpenClaw root directory is resolved
    const resolvedRoot = runtime.getResolvedOpenClawRootDir();

    // Then the checkout root is discovered by walking up from cwd
    expect(resolvedRoot).toBe(fs.realpathSync(openClawRoot));
  });

  it("throws a helpful error when no OpenClaw root can be found", async () => {
    // Given package resolution failure and a cwd outside any OpenClaw checkout
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-missing-"));
    process.chdir(tempDir);

    const runtime = await loadRuntimeModule({
      packageResolve: new Error("not found"),
    });

    // When the OpenClaw root directory is resolved
    const resolveRoot = () => runtime.getResolvedOpenClawRootDir();

    // Then a helpful root-resolution error is thrown
    expect(resolveRoot).toThrow(
      "agent-control: unable to resolve openclaw package root for internal tool schema access",
    );
  });

  it("returns the first importable JavaScript candidate", async () => {
    // Given candidate module paths where only the second JavaScript file exists
    const openClawRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-import-js-"));
    fs.mkdirSync(path.join(openClawRoot, "dist"), { recursive: true });
    fs.writeFileSync(path.join(openClawRoot, "dist", "candidate.mjs"), "export const value = 123;\n", "utf8");

    const runtime = await loadRuntimeModule();

    // When OpenClaw internals are imported through the JavaScript candidate list
    const imported = await runtime.tryImportOpenClawInternalModule(openClawRoot, [
      "dist/missing.mjs",
      "dist/candidate.mjs",
    ]);

    // Then the first importable JavaScript module is returned
    expect(imported).toMatchObject({ value: 123 });
  });

  it("loads a TypeScript candidate through jiti", async () => {
    // Given a TypeScript candidate file under the OpenClaw source tree
    const openClawRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-import-ts-"));
    fs.mkdirSync(path.join(openClawRoot, "src"), { recursive: true });
    fs.writeFileSync(path.join(openClawRoot, "src", "candidate.ts"), "export const value = 123;\n", "utf8");

    const runtime = await loadRuntimeModule();

    // When the runtime imports OpenClaw internals from TypeScript candidates
    const imported = await runtime.importOpenClawInternalModule(openClawRoot, ["src/candidate.ts"]);

    // Then the TypeScript module is loaded successfully through jiti
    expect(imported).toMatchObject({ value: 123 });
  });

  it("names attempted candidates when no module can be imported", async () => {
    // Given an OpenClaw root with no importable internal module candidates
    const openClawRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-import-missing-"));
    const runtime = await loadRuntimeModule();

    // When the runtime attempts to import from the candidate list
    const importPromise = runtime.importOpenClawInternalModule(openClawRoot, [
      "src/missing.ts",
      "dist/missing.js",
    ]);

    // Then the thrown error names the attempted candidate paths
    await expect(
      importPromise,
    ).rejects.toThrow(
      `agent-control: openclaw internal module not found (src/missing.ts, dist/missing.js) under ${openClawRoot}`,
    );
  });
});
