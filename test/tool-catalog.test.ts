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

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.useRealTimers();
  vi.doUnmock("../src/openclaw-runtime.ts");
});

describe("resolveStepsForContext", () => {
  it("deduplicates definitions and disables plugins in synced config", async () => {
    // Given duplicate, invalid, and blank tool definitions from OpenClaw internals
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

    // When steps are resolved for the source agent and session context
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

    // Then the last valid definition wins and synced config disables plugins
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

  it("falls back to source modules when dist internals are unavailable", async () => {
    // Given a fixture where dist internals are missing but source modules are available
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

    // When steps are resolved for the source agent
    const steps = await resolveStepsForContext({
      api: createApi({}),
      logger: createLogger(),
      sourceAgentId: "worker-1",
    });

    // Then the source-module fallback is used to build tool steps
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

  it("caches resolved steps briefly for the same agent, session, and config", async () => {
    // Given an expensive OpenClaw tool catalog resolver for one session
    vi.useFakeTimers();
    const createOpenClawCodingTools = vi
      .fn()
      .mockReturnValueOnce(["first-tool-marker"])
      .mockReturnValueOnce(["second-tool-marker"]);
    const toToolDefinitions = vi
      .fn()
      .mockReturnValueOnce([
        {
          name: "shell",
          label: "Shell",
          description: "Run a shell command",
          parameters: { type: "object" },
        },
      ])
      .mockReturnValueOnce([
        {
          name: "grep",
          label: "Grep",
          description: "Search files",
          parameters: { type: "object" },
        },
      ]);

    const { resolveStepsForContext } = await loadToolCatalogModule({
      openClawRoot: fs.mkdtempSync(path.join(os.tmpdir(), "tool-catalog-cache-")),
      distPiToolsModule: { createOpenClawCodingTools },
      distAdapterModule: { toToolDefinitions },
    });
    const logger = createLogger();
    const request = {
      api: createApi({ mode: "test" }),
      logger,
      sourceAgentId: "worker-1",
      sessionKey: "agent:worker-1:slack:direct:alice",
    };

    // When the same context is resolved twice before the cache TTL expires
    const first = await resolveStepsForContext(request);
    const second = await resolveStepsForContext(request);

    // Then the second call reuses the cached step catalog
    expect(second).toEqual(first);
    expect(createOpenClawCodingTools).toHaveBeenCalledTimes(1);
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining("resolve_steps cache_hit"));

    // When the cache TTL expires
    vi.advanceTimersByTime(30_001);
    const refreshed = await resolveStepsForContext(request);

    // Then the catalog is refreshed from OpenClaw internals
    expect(refreshed).toEqual([
      {
        type: "tool",
        name: "grep",
        description: "Search files",
        inputSchema: { type: "object" },
        metadata: { label: "Grep" },
      },
    ]);
    expect(createOpenClawCodingTools).toHaveBeenCalledTimes(2);
  });

  it("does not reuse cached steps across different run context identifiers", async () => {
    // Given two calls with the same session key but different run context identifiers
    const createOpenClawCodingTools = vi
      .fn()
      .mockReturnValueOnce(["first-tool-marker"])
      .mockReturnValueOnce(["second-tool-marker"]);
    const toToolDefinitions = vi
      .fn()
      .mockReturnValueOnce([
        {
          name: "shell",
          label: "Shell",
          description: "Run a shell command",
          parameters: { type: "object" },
        },
      ])
      .mockReturnValueOnce([
        {
          name: "grep",
          label: "Grep",
          description: "Search files",
          parameters: { type: "object" },
        },
      ]);

    const { resolveStepsForContext } = await loadToolCatalogModule({
      openClawRoot: fs.mkdtempSync(path.join(os.tmpdir(), "tool-catalog-run-context-")),
      distPiToolsModule: { createOpenClawCodingTools },
      distAdapterModule: { toToolDefinitions },
    });
    const baseRequest = {
      api: createApi({ mode: "test" }),
      logger: createLogger(),
      sourceAgentId: "worker-1",
      sessionKey: "agent:worker-1:slack:direct:alice",
    };

    // When steps are resolved for different session and run identifiers
    const first = await resolveStepsForContext({
      ...baseRequest,
      sessionId: "session-1",
      runId: "run-1",
    });
    const second = await resolveStepsForContext({
      ...baseRequest,
      sessionId: "session-2",
      runId: "run-2",
    });

    // Then each context resolves its own catalog rather than sharing a stale cache entry
    expect(first).toEqual([
      {
        type: "tool",
        name: "shell",
        description: "Run a shell command",
        inputSchema: { type: "object" },
        metadata: { label: "Shell" },
      },
    ]);
    expect(second).toEqual([
      {
        type: "tool",
        name: "grep",
        description: "Search files",
        inputSchema: { type: "object" },
        metadata: { label: "Grep" },
      },
    ]);
    expect(createOpenClawCodingTools).toHaveBeenCalledTimes(2);
  });

  it("deduplicates concurrent step resolution for the same cache key", async () => {
    // Given OpenClaw internals are still loading when two identical step resolutions start
    const internalsDeferred = createDeferred<Record<string, unknown> | null>();
    const createOpenClawCodingTools = vi.fn(() => ["tool-marker"]);
    const toToolDefinitions = vi.fn(() => [
      {
        name: "shell",
        label: "Shell",
        description: "Run a shell command",
        parameters: { type: "object" },
      },
    ]);
    vi.resetModules();

    const tryImportOpenClawInternalModule = vi.fn(() => internalsDeferred.promise);
    vi.doMock("../src/openclaw-runtime.ts", () => ({
      getResolvedOpenClawRootDir: () => "/openclaw",
      tryImportOpenClawInternalModule,
      importOpenClawInternalModule: vi.fn(),
      normalizeRelativeImportPath: vi.fn(),
      PLUGIN_ROOT_DIR: "/plugin",
      readPackageVersion: vi.fn(() => "1.0.0"),
      safeStatMtimeMs: vi.fn(() => null),
    }));

    const { resolveStepsForContext } = await import("../src/tool-catalog.ts");
    const logger = createLogger();
    const request = {
      api: createApi({ mode: "test" }),
      logger,
      sourceAgentId: "worker-1",
      sessionKey: "agent:worker-1:slack:direct:alice",
    };

    // When both callers request the same catalog before internals finish loading
    const firstPromise = resolveStepsForContext(request);
    const secondPromise = resolveStepsForContext(request);
    await Promise.resolve();
    internalsDeferred.resolve({ createOpenClawCodingTools, toToolDefinitions });

    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    // Then both callers share one resolver invocation and receive the same steps
    expect(first).toEqual(second);
    expect(createOpenClawCodingTools).toHaveBeenCalledTimes(1);
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining("resolve_steps cache_join"));
  });
});
