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
    // Given
    const { resolveSessionIdentity } = await loadSessionStoreModule();

    // When
    const identityPromise = resolveSessionIdentity(undefined);

    // Then
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
    // Given
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

    // When
    const identityPromise = resolveSessionIdentity("agent:worker-1:slack:direct:alice");

    // Then
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
    // Given
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

    // When
    const identityPromise = resolveSessionIdentity("agent:worker-1:slack:channel:eng:thread:123");

    // Then
    await expect(identityPromise).resolves.toMatchObject({
      provider: "slack",
      type: "channel",
      channelName: "eng",
      label: "Engineering",
      source: "sessionStore",
    });
  });

  it("reuses the cached identity before the TTL expires", async () => {
    // Given
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

    // When
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

    // Then
    expect(first.label).toBe("Alice");
    expect(second.label).toBe("Alice");
    expect(mocks.loadSessionStore).toHaveBeenCalledTimes(1);
  });

  it("refreshes the identity after the TTL expires", async () => {
    // Given
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

    // When
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

    // Then
    await expect(resolveSessionIdentity("agent:worker-1:slack:direct:alice")).resolves.toMatchObject({
      label: "Bob",
    });
    expect(mocks.loadSessionStore).toHaveBeenCalledTimes(2);
  });

  it("returns an unknown identity when session-store internals cannot be loaded", async () => {
    // Given
    const { resolveSessionIdentity } = await loadSessionStoreModule({
      throws: true,
    });

    // When
    const identityPromise = resolveSessionIdentity("agent:worker-1:slack:direct:alice");

    // Then
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
