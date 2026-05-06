import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";

type SessionStoreFixture = {
  config?: Record<string, unknown>;
  initialStore?: Record<string, unknown>;
  throws?: boolean;
};

async function loadSessionStoreModule(fixture: SessionStoreFixture = {}) {
  vi.resetModules();

  let currentStore = fixture.initialStore ?? {};
  const loadConfig = vi.fn(() => fixture.config ?? {});
  const resolveStorePath = vi.fn((storePath?: string) => storePath ?? "/tmp/session-store.json");
  const loadSessionStore = vi.fn(() => currentStore);
  const importOpenClawInternalModule = vi.fn(async (_openClawRoot: string, candidates: string[]) => {
    if (fixture.throws) {
      throw new Error("internal module load failed");
    }
    if (candidates.some((candidate) => candidate.includes("sessions"))) {
      return { resolveStorePath, loadSessionStore };
    }
    return { loadConfig };
  });

  vi.doMock("../src/openclaw-runtime.ts", () => ({
    getResolvedOpenClawRootDir: () => "/openclaw",
    importOpenClawInternalModule,
  }));

  const module = await import("../src/session-store.ts");
  return {
    resolveSessionIdentity: module.resolveSessionIdentity,
    warmSessionIdentityResolver: module.warmSessionIdentityResolver,
    mocks: {
      importOpenClawInternalModule,
      loadConfig,
      resolveStorePath,
      loadSessionStore,
      setStore(store: Record<string, unknown>) {
        currentStore = store;
      },
    },
  };
}

function createApi(params: {
  config?: Record<string, unknown>;
  loadConfig?: () => Record<string, unknown>;
  resolveStorePath?: (storePath?: string, opts?: { agentId?: string }) => string;
  loadSessionStore?: (storePath: string) => Record<string, unknown>;
}): OpenClawPluginApi {
  return {
    id: "agent-control-openclaw-plugin",
    version: "test-version",
    config: params.config ?? {},
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
    },
    on: vi.fn(),
    runtime: {
      config: {
        loadConfig: params.loadConfig,
      },
      agent: {
        session: {
          resolveStorePath: params.resolveStorePath,
          loadSessionStore: params.loadSessionStore,
        },
      },
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.doUnmock("../src/openclaw-runtime.ts");
});

describe("resolveSessionIdentity", () => {
  it("returns an unknown identity when no session key is provided", async () => {
    // Given the session-store resolver with no session key input
    const { resolveSessionIdentity } = await loadSessionStoreModule();

    // When session identity is resolved
    const identityPromise = resolveSessionIdentity(undefined);

    // Then an unknown identity object is returned
    await expect(identityPromise).resolves.toEqual({
      provider: null,
      type: "unknown",
      channelName: null,
      dmUserName: null,
      label: null,
      from: null,
      to: null,
      accountId: null,
      source: "unknown",
    });
  });

  it("maps direct-message metadata from the session store", async () => {
    // Given a session-store entry for a direct-message conversation
    const { resolveSessionIdentity } = await loadSessionStoreModule({
      initialStore: {
        "agent:worker-1:slack:direct:alice": {
          origin: {
            provider: "slack",
            chatType: "direct",
            label: "Alice",
            from: "alice@example.com",
            to: "bot@example.com",
            accountId: "acct-1",
          },
          displayName: "Alice Display",
        },
      },
    });

    // When identity is resolved for that direct-message session key
    const identityPromise = resolveSessionIdentity("agent:worker-1:slack:direct:alice");

    // Then the direct-message metadata is mapped into the returned identity
    await expect(identityPromise).resolves.toEqual({
      provider: "slack",
      type: "direct",
      channelName: null,
      dmUserName: "Alice",
      label: "Alice",
      from: "alice@example.com",
      to: "bot@example.com",
      accountId: "acct-1",
      source: "sessionStore",
    });
  });

  it("reuses base session metadata for thread-specific keys", async () => {
    // Given only a base channel session entry and a thread-specific lookup key
    const { resolveSessionIdentity } = await loadSessionStoreModule({
      initialStore: {
        "agent:worker-1:slack:channel:eng": {
          origin: {
            provider: "slack",
            chatType: "channel",
            label: "Engineering",
          },
          groupChannel: "eng",
        },
      },
    });

    // When identity is resolved for the thread-specific key
    const identityPromise = resolveSessionIdentity("agent:worker-1:slack:channel:eng:thread:123");

    // Then the base session metadata is reused for the thread
    await expect(identityPromise).resolves.toMatchObject({
      provider: "slack",
      type: "channel",
      channelName: "eng",
      label: "Engineering",
      source: "sessionStore",
    });
  });

  it("reuses the cached identity before the TTL expires", async () => {
    // Given cached session metadata and a TTL window that has not expired
    vi.useFakeTimers();
    const { resolveSessionIdentity, mocks } = await loadSessionStoreModule({
      initialStore: {
        "agent:worker-1:slack:direct:alice": {
          origin: {
            provider: "slack",
            chatType: "direct",
            label: "Alice",
          },
        },
      },
    });

    // When the same session is resolved twice after the backing store changes
    const first = await resolveSessionIdentity("agent:worker-1:slack:direct:alice");
    mocks.setStore({
      "agent:worker-1:slack:direct:alice": {
        origin: {
          provider: "slack",
          chatType: "direct",
          label: "Bob",
        },
      },
    });
    const second = await resolveSessionIdentity("agent:worker-1:slack:direct:alice");

    // Then the cached identity is reused and the store is only loaded once
    expect(first.label).toBe("Alice");
    expect(second.label).toBe("Alice");
    expect(mocks.loadSessionStore).toHaveBeenCalledTimes(1);
  });

  it("refreshes the identity after the TTL expires", async () => {
    // Given cached session-store metadata and a store update after the TTL window
    vi.useFakeTimers();
    const { resolveSessionIdentity, mocks } = await loadSessionStoreModule({
      initialStore: {
        "agent:worker-1:slack:direct:alice": {
          origin: {
            provider: "slack",
            chatType: "direct",
            label: "Alice",
          },
        },
      },
    });

    // When the session is resolved again after advancing past the TTL
    await expect(resolveSessionIdentity("agent:worker-1:slack:direct:alice")).resolves.toMatchObject({
      label: "Alice",
    });

    mocks.setStore({
      "agent:worker-1:slack:direct:alice": {
        origin: {
          provider: "slack",
          chatType: "direct",
          label: "Bob",
        },
      },
    });
    vi.advanceTimersByTime(2_001);

    // Then the refreshed identity is returned and the store is reloaded
    await expect(resolveSessionIdentity("agent:worker-1:slack:direct:alice")).resolves.toMatchObject({
      label: "Bob",
    });
    expect(mocks.loadSessionStore).toHaveBeenCalledTimes(2);
  });

  it("keys cached identity by resolved store path", async () => {
    // Given two source agents can resolve the same legacy key in separate stores
    const { resolveSessionIdentity, mocks } = await loadSessionStoreModule({
      throws: true,
    });
    const loadConfig = vi.fn(() => ({
      session: {
        store: "/tmp/{agentId}/sessions.json",
      },
    }));
    const resolveStorePath = vi.fn(
      (storePath?: string, opts?: { agentId?: string }) =>
        (storePath ?? "").replace("{agentId}", opts?.agentId ?? "main"),
    );
    const loadSessionStore = vi.fn((storePath: string) => ({
      "/tmp/worker-1/sessions.json": {
        "legacy-session": {
          origin: {
            provider: "slack",
            chatType: "direct",
            label: "Alice",
          },
        },
      },
      "/tmp/worker-2/sessions.json": {
        "legacy-session": {
          origin: {
            provider: "discord",
            chatType: "channel",
            label: "House Buying",
          },
        },
      },
    })[storePath] ?? {});
    const api = createApi({ loadConfig, resolveStorePath, loadSessionStore });

    // When the same session key is resolved for two different source agents
    const first = await resolveSessionIdentity({
      api,
      sourceAgentId: "worker-1",
      sessionKey: "legacy-session",
    });
    const second = await resolveSessionIdentity({
      api,
      sourceAgentId: "worker-2",
      sessionKey: "legacy-session",
    });

    // Then each lookup returns metadata from its own resolved store
    expect(first).toMatchObject({
      provider: "slack",
      label: "Alice",
      type: "direct",
    });
    expect(second).toMatchObject({
      provider: "discord",
      label: "House Buying",
      type: "channel",
    });
    expect(loadSessionStore).toHaveBeenCalledTimes(2);
    expect(mocks.importOpenClawInternalModule).not.toHaveBeenCalled();
  });

  it("uses the OpenClaw default store for legacy keys when source agent is synthetic default", async () => {
    // Given the plugin fallback source agent ID is the synthetic default value
    const { resolveSessionIdentity, mocks } = await loadSessionStoreModule({
      throws: true,
    });
    const loadConfig = vi.fn(() => ({
      session: {
        store: "/tmp/{agentId}/sessions.json",
      },
    }));
    const resolveStorePath = vi.fn(
      (storePath?: string, opts?: { agentId?: string }) =>
        (storePath ?? "").replace("{agentId}", opts?.agentId ?? "main"),
    );
    const loadSessionStore = vi.fn(() => ({
      "legacy-session": {
        origin: {
          provider: "slack",
          chatType: "direct",
          label: "Alice",
        },
      },
    }));
    const api = createApi({ loadConfig, resolveStorePath, loadSessionStore });

    // When identity is resolved for a non-agent-prefixed session key
    const identity = await resolveSessionIdentity({
      api,
      sourceAgentId: "default",
      sessionKey: "legacy-session",
    });

    // Then the OpenClaw runtime resolves its own default agent store
    expect(identity).toMatchObject({
      provider: "slack",
      type: "direct",
      label: "Alice",
    });
    expect(resolveStorePath).toHaveBeenCalledWith("/tmp/{agentId}/sessions.json", {
      agentId: undefined,
    });
    expect(loadSessionStore).toHaveBeenCalledWith("/tmp/main/sessions.json");
    expect(mocks.importOpenClawInternalModule).not.toHaveBeenCalled();
  });

  it("uses injected runtime helpers before falling back to internal imports", async () => {
    // Given OpenClaw provides session-store helpers through the plugin runtime
    const { resolveSessionIdentity, mocks } = await loadSessionStoreModule({
      throws: true,
    });
    const loadConfig = vi.fn(() => ({
      session: {
        store: "/tmp/{agentId}/sessions.json",
      },
    }));
    const resolveStorePath = vi.fn(
      (storePath?: string, opts?: { agentId?: string }) =>
        (storePath ?? "").replace("{agentId}", opts?.agentId ?? "main"),
    );
    const loadSessionStore = vi.fn(() => ({
      "agent:worker-1:slack:direct:alice": {
        origin: {
          provider: "slack",
          chatType: "direct",
          label: "Alice",
        },
      },
    }));
    const api = createApi({ loadConfig, resolveStorePath, loadSessionStore });

    // When identity is resolved with a runtime-aware API object
    const identity = await resolveSessionIdentity({
      api,
      sessionKey: "agent:worker-1:slack:direct:alice",
    });

    // Then runtime helpers are used and the store path is scoped to the session agent
    expect(identity).toMatchObject({
      provider: "slack",
      type: "direct",
      label: "Alice",
      source: "sessionStore",
    });
    expect(resolveStorePath).toHaveBeenCalledWith("/tmp/{agentId}/sessions.json", {
      agentId: "worker-1",
    });
    expect(loadSessionStore).toHaveBeenCalledWith("/tmp/worker-1/sessions.json");
    expect(mocks.importOpenClawInternalModule).not.toHaveBeenCalled();
  });

  it("warms the session store through injected runtime helpers", async () => {
    // Given runtime helpers are available for the default source agent
    const { warmSessionIdentityResolver, mocks } = await loadSessionStoreModule({
      throws: true,
    });
    const loadConfig = vi.fn(() => ({
      session: {
        store: "/tmp/{agentId}/sessions.json",
      },
    }));
    const resolveStorePath = vi.fn(
      (storePath?: string, opts?: { agentId?: string }) =>
        (storePath ?? "").replace("{agentId}", opts?.agentId ?? "main"),
    );
    const loadSessionStore = vi.fn(() => ({}));
    const api = createApi({ loadConfig, resolveStorePath, loadSessionStore });

    // When the resolver is warmed for the default source agent
    await warmSessionIdentityResolver({
      api,
      sourceAgentId: "main",
    });

    // Then the backing store is loaded once through the runtime path
    expect(resolveStorePath).toHaveBeenCalledWith("/tmp/{agentId}/sessions.json", {
      agentId: "main",
    });
    expect(loadSessionStore).toHaveBeenCalledWith("/tmp/main/sessions.json");
    expect(mocks.importOpenClawInternalModule).not.toHaveBeenCalled();
  });

  it("deduplicates concurrent lookups for the same session key", async () => {
    // Given session-store internals that resolve asynchronously
    const { resolveSessionIdentity, mocks } = await loadSessionStoreModule({
      initialStore: {
        "agent:worker-1:slack:direct:alice": {
          origin: {
            provider: "slack",
            chatType: "direct",
            label: "Alice",
          },
        },
      },
    });

    // When two callers resolve the same session before the first lookup finishes
    const [first, second] = await Promise.all([
      resolveSessionIdentity("agent:worker-1:slack:direct:alice"),
      resolveSessionIdentity("agent:worker-1:slack:direct:alice"),
    ]);

    // Then the backing store is loaded once and both callers receive the identity
    expect(first.label).toBe("Alice");
    expect(second.label).toBe("Alice");
    expect(mocks.loadSessionStore).toHaveBeenCalledTimes(1);
  });

  it("returns an unknown identity when session-store internals cannot be loaded", async () => {
    // Given a runtime fixture where OpenClaw session-store internals fail to load
    const { resolveSessionIdentity } = await loadSessionStoreModule({
      throws: true,
    });

    // When identity is resolved for any session key
    const identityPromise = resolveSessionIdentity("agent:worker-1:slack:direct:alice");

    // Then the resolver falls back to an unknown identity
    await expect(identityPromise).resolves.toEqual({
      provider: null,
      type: "unknown",
      channelName: null,
      dmUserName: null,
      label: null,
      from: null,
      to: null,
      accountId: null,
      source: "unknown",
    });
  });
});
