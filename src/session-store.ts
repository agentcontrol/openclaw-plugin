import type { SessionIdentitySnapshot, SessionMetadataCacheEntry, SessionStoreInternals } from "./types.ts";
import { asString, isRecord } from "./shared.ts";
import { getResolvedOpenClawRootDir, importOpenClawInternalModule } from "./openclaw-runtime.ts";

const SESSION_META_CACHE_TTL_MS = 2_000;
const SESSION_META_CACHE_MAX = 512;

let sessionStoreInternalsPromise: Promise<SessionStoreInternals> | null = null;
const sessionMetadataCache = new Map<string, SessionMetadataCacheEntry>();

async function loadSessionStoreInternals(): Promise<SessionStoreInternals> {
  if (sessionStoreInternalsPromise) {
    return sessionStoreInternalsPromise;
  }

  sessionStoreInternalsPromise = (async () => {
    const openClawRoot = getResolvedOpenClawRootDir();
    const [configModule, sessionsModule] = await Promise.all([
      importOpenClawInternalModule(openClawRoot, [
        "dist/config/config.js",
        "src/config/config.ts",
      ]),
      importOpenClawInternalModule(openClawRoot, [
        "dist/config/sessions.js",
        "src/config/sessions.ts",
      ]),
    ]);

    const loadConfig = configModule.loadConfig;
    const resolveStorePath = sessionsModule.resolveStorePath;
    const loadSessionStore = sessionsModule.loadSessionStore;

    if (typeof loadConfig !== "function") {
      throw new Error("agent-control: openclaw internal loadConfig is unavailable");
    }
    if (typeof resolveStorePath !== "function") {
      throw new Error("agent-control: openclaw internal resolveStorePath is unavailable");
    }
    if (typeof loadSessionStore !== "function") {
      throw new Error("agent-control: openclaw internal loadSessionStore is unavailable");
    }

    return {
      loadConfig: loadConfig as SessionStoreInternals["loadConfig"],
      resolveStorePath: resolveStorePath as SessionStoreInternals["resolveStorePath"],
      loadSessionStore: loadSessionStore as SessionStoreInternals["loadSessionStore"],
    };
  })();

  return sessionStoreInternalsPromise;
}

function unknownSessionIdentity(): SessionIdentitySnapshot {
  return {
    provider: null,
    type: "unknown",
    channelName: null,
    dmUserName: null,
    label: null,
    from: null,
    to: null,
    accountId: null,
    source: "unknown",
  };
}

function normalizeSessionStoreKey(sessionKey: string | undefined): string | undefined {
  const normalized = asString(sessionKey)?.toLowerCase();
  return normalized || undefined;
}

function resolveBaseSessionKey(sessionKey: string): string {
  const topicIndex = sessionKey.lastIndexOf(":topic:");
  const threadIndex = sessionKey.lastIndexOf(":thread:");
  const markerIndex = Math.max(topicIndex, threadIndex);
  if (markerIndex < 0) {
    return sessionKey;
  }
  const base = sessionKey.slice(0, markerIndex);
  return base || sessionKey;
}

function readSessionIdentityFromEntry(entry: Record<string, unknown>): SessionIdentitySnapshot {
  const origin = isRecord(entry.origin) ? entry.origin : undefined;
  const deliveryContext = isRecord(entry.deliveryContext) ? entry.deliveryContext : undefined;

  const rawType = asString(origin?.chatType);
  const type = rawType === "direct" || rawType === "group" || rawType === "channel" ? rawType : "unknown";

  const label = asString(origin?.label) ?? null;
  const provider =
    asString(origin?.provider) ??
    asString(entry.channel) ??
    asString(deliveryContext?.channel) ??
    null;

  const channelName =
    asString(entry.groupChannel) ??
    asString(entry.subject) ??
    (type !== "direct" ? label : undefined) ??
    null;

  const dmUserName = type === "direct" ? label ?? asString(entry.displayName) ?? null : null;

  return {
    provider,
    type,
    channelName,
    dmUserName,
    label,
    from: asString(origin?.from) ?? null,
    to: asString(origin?.to) ?? asString(deliveryContext?.to) ?? null,
    accountId:
      asString(origin?.accountId) ??
      asString(deliveryContext?.accountId) ??
      asString(entry.lastAccountId) ??
      null,
    source: "sessionStore",
  };
}

function setSessionMetadataCache(key: string, data: SessionIdentitySnapshot): void {
  sessionMetadataCache.set(key, { at: Date.now(), data });
  if (sessionMetadataCache.size > SESSION_META_CACHE_MAX) {
    const oldest = sessionMetadataCache.keys().next().value;
    if (typeof oldest === "string") {
      sessionMetadataCache.delete(oldest);
    }
  }
}

export async function resolveSessionIdentity(
  sessionKey: string | undefined,
): Promise<SessionIdentitySnapshot> {
  const normalizedKey = normalizeSessionStoreKey(sessionKey);
  if (!normalizedKey) {
    return unknownSessionIdentity();
  }

  const cached = sessionMetadataCache.get(normalizedKey);
  if (cached && Date.now() - cached.at < SESSION_META_CACHE_TTL_MS) {
    return cached.data;
  }

  try {
    const internals = await loadSessionStoreInternals();
    const cfg = internals.loadConfig();
    const sessionCfg = isRecord(cfg.session) ? cfg.session : undefined;
    const storePath = internals.resolveStorePath(asString(sessionCfg?.store));
    const store = internals.loadSessionStore(storePath);
    const entry =
      (isRecord(store[normalizedKey]) ? store[normalizedKey] : undefined) ??
      (isRecord(store[resolveBaseSessionKey(normalizedKey)])
        ? store[resolveBaseSessionKey(normalizedKey)]
        : undefined);
    const data = entry ? readSessionIdentityFromEntry(entry) : unknownSessionIdentity();
    setSessionMetadataCache(normalizedKey, data);
    return data;
  } catch {
    return unknownSessionIdentity();
  }
}
