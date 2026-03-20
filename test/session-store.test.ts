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
  vi.unmock("../src/openclaw-runtime.ts");
});

describe("resolveSessionIdentity", () => {
  it("Given no session key, when session identity is resolved, then an unknown identity is returned", async () => {
    const { resolveSessionIdentity } = await loadSessionStoreModule();

    await expect(resolveSessionIdentity(undefined)).resolves.toEqual({
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

  it("Given a direct-message session entry, when session identity is resolved, then DM metadata is mapped from the store", async () => {
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

    await expect(resolveSessionIdentity("agent:worker-1:slack:direct:alice")).resolves.toEqual({
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

  it("Given only a base session entry exists, when a thread-specific session key is resolved, then the base session metadata is used", async () => {
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

    await expect(
      resolveSessionIdentity("agent:worker-1:slack:channel:eng:thread:123"),
    ).resolves.toMatchObject({
      provider: "slack",
      type: "channel",
      channelName: "eng",
      label: "Engineering",
      source: "sessionStore",
    });
  });

  it("Given the same session is resolved twice before the TTL expires, when the underlying store changes, then the cached identity is reused", async () => {
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

    expect(first.label).toBe("Alice");
    expect(second.label).toBe("Alice");
    expect(mocks.loadSessionStore).toHaveBeenCalledTimes(1);
  });

  it("Given the session metadata TTL has expired, when the underlying store changes, then the refreshed identity is returned", async () => {
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

    await expect(resolveSessionIdentity("agent:worker-1:slack:direct:alice")).resolves.toMatchObject({
      label: "Bob",
    });
    expect(mocks.loadSessionStore).toHaveBeenCalledTimes(2);
  });

  it("Given the OpenClaw session-store internals cannot be loaded, when session identity is resolved, then an unknown identity is returned", async () => {
    const { resolveSessionIdentity } = await loadSessionStoreModule({
      throws: true,
    });

    await expect(resolveSessionIdentity("agent:worker-1:slack:direct:alice")).resolves.toEqual({
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
