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
  vi.unmock("node:module");
  vi.unmock("../src/openclaw-runtime.ts");
});

describe("openclaw runtime helpers", () => {
  it("Given a valid package.json, when package fields are read, then name and version are returned", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-runtime-pkg-"));
    const packageJsonPath = path.join(tempDir, "package.json");
    fs.writeFileSync(
      packageJsonPath,
      JSON.stringify({ name: "openclaw", version: "1.2.3" }),
      "utf8",
    );

    const runtime = await loadRuntimeModule();

    expect(runtime.readPackageName(packageJsonPath)).toBe("openclaw");
    expect(runtime.readPackageVersion(packageJsonPath)).toBe("1.2.3");
  });

  it("Given source and target files in sibling directories, when the import path is normalized, then a relative posix path with a leading dot is returned", async () => {
    const runtime = await loadRuntimeModule();

    expect(runtime.normalizeRelativeImportPath("/tmp/a/b", "/tmp/a/c/tool.ts")).toBe("../c/tool.ts");
    expect(runtime.normalizeRelativeImportPath("/tmp/a/b", "/tmp/a/b/tool.ts")).toBe("./tool.ts");
  });

  it("Given package resolution is unavailable but the current working directory is inside an OpenClaw checkout, when the root dir is resolved, then the checkout root is found from cwd", async () => {
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

    expect(runtime.getResolvedOpenClawRootDir()).toBe(fs.realpathSync(openClawRoot));
  });

  it("Given package resolution is unavailable and no OpenClaw checkout can be found, when the root dir is resolved, then a helpful error is thrown", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-missing-"));
    process.chdir(tempDir);

    const runtime = await loadRuntimeModule({
      packageResolve: new Error("not found"),
    });

    expect(() => runtime.getResolvedOpenClawRootDir()).toThrow(
      "agent-control: unable to resolve openclaw package root for internal tool schema access",
    );
  });

  it("Given a JavaScript candidate exists, when tryImportOpenClawInternalModule is called, then the first importable candidate is returned", async () => {
    const openClawRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-import-js-"));
    fs.mkdirSync(path.join(openClawRoot, "dist"), { recursive: true });
    fs.writeFileSync(path.join(openClawRoot, "dist", "candidate.mjs"), "export const value = 123;\n", "utf8");

    const runtime = await loadRuntimeModule();
    const imported = await runtime.tryImportOpenClawInternalModule(openClawRoot, [
      "dist/missing.mjs",
      "dist/candidate.mjs",
    ]);

    expect(imported).toMatchObject({ value: 123 });
  });

  it("Given a TypeScript candidate exists, when importOpenClawInternalModule is called, then the module is loaded through jiti", async () => {
    const openClawRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-import-ts-"));
    fs.mkdirSync(path.join(openClawRoot, "src"), { recursive: true });
    fs.writeFileSync(path.join(openClawRoot, "src", "candidate.ts"), "export const value = 123;\n", "utf8");

    const runtime = await loadRuntimeModule();
    const imported = await runtime.importOpenClawInternalModule(openClawRoot, ["src/candidate.ts"]);

    expect(imported).toMatchObject({ value: 123 });
  });

  it("Given no candidates are importable, when importOpenClawInternalModule is called, then the thrown error names the attempted candidates", async () => {
    const openClawRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-import-missing-"));
    const runtime = await loadRuntimeModule();

    await expect(
      runtime.importOpenClawInternalModule(openClawRoot, ["src/missing.ts", "dist/missing.js"]),
    ).rejects.toThrow(
      `agent-control: openclaw internal module not found (src/missing.ts, dist/missing.js) under ${openClawRoot}`,
    );
  });
});
