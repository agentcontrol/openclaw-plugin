import { afterEach, describe, expect, it, vi } from "vitest";

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
    // Given cached session metadata and a store update after the TTL window
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
