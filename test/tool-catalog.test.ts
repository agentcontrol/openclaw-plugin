import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { afterEach, describe, expect, it, vi } from "vitest";

type ToolCatalogFixture = {
  openClawRoot: string;
  distPiToolsModule?: Record<string, unknown> | null;
  distAdapterModule?: Record<string, unknown> | null;
  sourcePiToolsModule?: Record<string, unknown>;
  sourceAdapterModule?: Record<string, unknown>;
};

async function loadToolCatalogModule(fixture: ToolCatalogFixture) {
  vi.resetModules();

  const tryImportOpenClawInternalModule = vi.fn(
    async (_openClawRoot: string, candidates: string[]) => {
      if (candidates.some((candidate) => candidate.includes("pi-tools"))) {
        return fixture.distPiToolsModule ?? null;
      }
      return fixture.distAdapterModule ?? null;
    },
  );

  const importOpenClawInternalModule = vi.fn(
    async (_openClawRoot: string, candidates: string[]) => {
      if (candidates.some((candidate) => candidate.includes("pi-tools"))) {
        return fixture.sourcePiToolsModule ?? {};
      }
      return fixture.sourceAdapterModule ?? {};
    },
  );

  vi.doMock("../src/openclaw-runtime.ts", () => ({
    getResolvedOpenClawRootDir: () => fixture.openClawRoot,
    tryImportOpenClawInternalModule,
    importOpenClawInternalModule,
    normalizeRelativeImportPath: vi.fn((fromDir: string, toFile: string) =>
      path.relative(fromDir, toFile),
    ),
    PLUGIN_ROOT_DIR: path.join(fixture.openClawRoot, "plugin"),
    readPackageVersion: vi.fn(() => "1.0.0"),
    safeStatMtimeMs: vi.fn(() => null),
  }));

  const module = await import("../src/tool-catalog.ts");
  return {
    resolveStepsForContext: module.resolveStepsForContext,
    mocks: {
      tryImportOpenClawInternalModule,
      importOpenClawInternalModule,
    },
  };
}

function createApi(config: Record<string, unknown>): OpenClawPluginApi {
  return {
    id: "agent-control-openclaw-plugin",
    version: "test-version",
    config,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
    },
    on: vi.fn(),
  };
}

function createLogger() {
  return {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    block: vi.fn(),
  };
}

afterEach(() => {
  vi.unmock("../src/openclaw-runtime.ts");
});

describe("resolveStepsForContext", () => {
  it("Given duplicate and invalid tool definitions, when steps are resolved, then the last valid definition wins and the synced config disables plugins", async () => {
    const createOpenClawCodingTools = vi.fn(() => ["tool-marker"]);
    const toToolDefinitions = vi.fn(() => [
      {
        name: "shell",
        label: "Shell v1",
        description: "Run a shell command",
        parameters: { type: "object", title: "v1" },
      },
      {
        name: "shell",
        label: "Shell v2",
        description: "Run a newer shell command",
        parameters: { type: "object", title: "v2" },
      },
      {
        name: "browser",
        label: "Browser",
        parameters: ["not-a-record"],
      },
      {
        name: "   ",
        label: "Ignored",
      },
    ]);

    const { resolveStepsForContext, mocks } = await loadToolCatalogModule({
      openClawRoot: fs.mkdtempSync(path.join(os.tmpdir(), "tool-catalog-dist-")),
      distPiToolsModule: { createOpenClawCodingTools },
      distAdapterModule: { toToolDefinitions },
    });
    const logger = createLogger();

    const steps = await resolveStepsForContext({
      api: createApi({
        plugins: {
          enabled: true,
          keepMe: "yes",
        },
        mode: "test",
      }),
      logger,
      sourceAgentId: "worker-1",
      sessionKey: "agent:worker-1:slack:direct:alice",
      sessionId: "session-1",
      runId: "run-1",
    });

    expect(steps).toEqual([
      {
        type: "tool",
        name: "shell",
        description: "Run a newer shell command",
        inputSchema: { type: "object", title: "v2" },
        metadata: { label: "Shell v2" },
      },
      {
        type: "tool",
        name: "browser",
        description: "Browser",
        metadata: { label: "Browser" },
      },
    ]);
    expect(createOpenClawCodingTools).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "worker-1",
        sessionKey: "agent:worker-1:slack:direct:alice",
        sessionId: "session-1",
        runId: "run-1",
        senderIsOwner: true,
        config: {
          plugins: {
            enabled: false,
            keepMe: "yes",
          },
          mode: "test",
        },
      }),
    );
    expect(mocks.importOpenClawInternalModule).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining("resolve_steps duration_sec="),
    );
  });

  it("Given dist internals are unavailable, when steps are resolved, then the source-module fallback is used", async () => {
    const openClawRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tool-catalog-source-"));
    const createOpenClawCodingTools = vi.fn(() => ["tool-marker"]);
    const toToolDefinitions = vi.fn(() => [
      {
        name: "shell",
        label: "Shell",
        description: "Run a shell command",
        parameters: { type: "object" },
      },
    ]);

    const { resolveStepsForContext, mocks } = await loadToolCatalogModule({
      openClawRoot,
      distPiToolsModule: null,
      distAdapterModule: null,
      sourcePiToolsModule: { createOpenClawCodingTools },
      sourceAdapterModule: { toToolDefinitions },
    });

    const steps = await resolveStepsForContext({
      api: createApi({}),
      logger: createLogger(),
      sourceAgentId: "worker-1",
    });

    expect(steps).toEqual([
      {
        type: "tool",
        name: "shell",
        description: "Run a shell command",
        inputSchema: { type: "object" },
        metadata: { label: "Shell" },
      },
    ]);
    expect(mocks.importOpenClawInternalModule).toHaveBeenCalledTimes(2);
    expect(mocks.importOpenClawInternalModule).toHaveBeenNthCalledWith(
      1,
      openClawRoot,
      ["src/agents/pi-tools.ts"],
    );
    expect(mocks.importOpenClawInternalModule).toHaveBeenNthCalledWith(
      2,
      openClawRoot,
      ["src/agents/pi-tool-definition-adapter.ts"],
    );
  });
});
