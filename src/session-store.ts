import type { SessionIdentitySnapshot, SessionMetadataCacheEntry, SessionStoreInternals } from "./types.ts";
import { asString, isRecord } from "./shared.ts";
import { getResolvedOpenClawRootDir, importOpenClawInternalModule } from "./openclaw-runtime.ts";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";

const SESSION_META_CACHE_TTL_MS = 2_000;
const SESSION_META_CACHE_MAX = 512;

let sessionStoreInternalsPromise: Promise<SessionStoreInternals> | null = null;
const sessionMetadataCache = new Map<string, SessionMetadataCacheEntry>();

function resolveRuntimeSessionStoreInternals(
  api: OpenClawPluginApi | undefined,
): SessionStoreInternals | null {
  const runtime = isRecord(api?.runtime) ? api.runtime : undefined;
  const runtimeConfig = isRecord(runtime?.config) ? runtime.config : undefined;
  const runtimeAgent = isRecord(runtime?.agent) ? runtime.agent : undefined;
  const runtimeAgentSession = isRecord(runtimeAgent?.session) ? runtimeAgent.session : undefined;

  const resolveStorePath = runtimeAgentSession?.resolveStorePath;
  const loadSessionStore = runtimeAgentSession?.loadSessionStore;
  if (typeof resolveStorePath !== "function" || typeof loadSessionStore !== "function") {
    return null;
  }

  const loadConfig = runtimeConfig?.loadConfig;
  const fallbackConfig = isRecord(api?.config) ? api.config : {};
  return {
    loadConfig:
      typeof loadConfig === "function"
        ? (loadConfig as SessionStoreInternals["loadConfig"])
        : () => fallbackConfig,
    resolveStorePath: resolveStorePath as SessionStoreInternals["resolveStorePath"],
    loadSessionStore: loadSessionStore as SessionStoreInternals["loadSessionStore"],
  };
}

async function loadSessionStoreInternals(
  api: OpenClawPluginApi | undefined,
): Promise<SessionStoreInternals> {
  const runtimeInternals = resolveRuntimeSessionStoreInternals(api);
  if (runtimeInternals) {
    return runtimeInternals;
  }

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

export async function warmSessionIdentityResolver(params: {
  api: OpenClawPluginApi;
  sourceAgentId?: string;
}): Promise<void> {
  const internals = await loadSessionStoreInternals(params.api);
  const cfg = internals.loadConfig();
  const sessionCfg = isRecord(cfg.session) ? cfg.session : undefined;
  const storePath = internals.resolveStorePath(asString(sessionCfg?.store), {
    agentId: asString(params.sourceAgentId),
  });
  internals.loadSessionStore(storePath);
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

function resolveSessionAgentId(
  normalizedSessionKey: string,
  sourceAgentId: string | undefined,
): string | undefined {
  const parts = normalizedSessionKey.split(":").filter(Boolean);
  if (parts.length >= 2 && parts[0] === "agent" && parts[1]) {
    return parts[1];
  }
  const normalizedSourceAgentId = asString(sourceAgentId);
  return normalizedSourceAgentId === "default" ? undefined : normalizedSourceAgentId;
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
  const now = Date.now();
  sessionMetadataCache.set(key, {
    at: now,
    data,
    expiresAt: now + SESSION_META_CACHE_TTL_MS,
  });
  if (sessionMetadataCache.size > SESSION_META_CACHE_MAX) {
    const oldest = sessionMetadataCache.keys().next().value;
    if (typeof oldest === "string") {
      sessionMetadataCache.delete(oldest);
    }
  }
}

function setSessionMetadataCachePromise(
  key: string,
  promise: Promise<SessionIdentitySnapshot>,
): void {
  sessionMetadataCache.set(key, { at: Date.now(), promise });
  if (sessionMetadataCache.size > SESSION_META_CACHE_MAX) {
    const oldest = sessionMetadataCache.keys().next().value;
    if (typeof oldest === "string" && oldest !== key) {
      sessionMetadataCache.delete(oldest);
    }
  }
}

async function readSessionIdentity(params: {
  normalizedKey: string;
  internals: SessionStoreInternals;
  storePath: string;
}): Promise<SessionIdentitySnapshot> {
  try {
    const store = params.internals.loadSessionStore(params.storePath);
    const directEntry = store[params.normalizedKey];
    const baseEntry = store[resolveBaseSessionKey(params.normalizedKey)];
    const entry: Record<string, unknown> | undefined = isRecord(directEntry)
      ? directEntry
      : isRecord(baseEntry)
        ? baseEntry
        : undefined;
    return entry ? readSessionIdentityFromEntry(entry) : unknownSessionIdentity();
  } catch {
    return unknownSessionIdentity();
  }
}

function buildSessionMetadataCacheKey(params: {
  normalizedKey: string;
  storePath: string;
}): string {
  return JSON.stringify({
    normalizedKey: params.normalizedKey,
    storePath: params.storePath,
  });
}

async function resolveSessionStoreLookupContext(params: {
  api?: OpenClawPluginApi;
  normalizedKey: string;
  sourceAgentId?: string;
}): Promise<{ internals: SessionStoreInternals; storePath: string } | null> {
  try {
    const internals = await loadSessionStoreInternals(params.api);
    const cfg = internals.loadConfig();
    const sessionCfg = isRecord(cfg.session) ? cfg.session : undefined;
    const storeAgentId = resolveSessionAgentId(params.normalizedKey, params.sourceAgentId);
    const storePath = internals.resolveStorePath(asString(sessionCfg?.store), {
      agentId: storeAgentId,
    });
    return { internals, storePath };
  } catch {
    return null;
  }
}

export async function resolveSessionIdentity(
  input:
    | string
    | undefined
    | {
        api?: OpenClawPluginApi;
        sessionKey?: string;
        sourceAgentId?: string;
      },
): Promise<SessionIdentitySnapshot> {
  const sessionKey = typeof input === "object" ? input.sessionKey : input;
  const api = typeof input === "object" ? input.api : undefined;
  const sourceAgentId = typeof input === "object" ? input.sourceAgentId : undefined;
  const normalizedKey = normalizeSessionStoreKey(sessionKey);
  if (!normalizedKey) {
    return unknownSessionIdentity();
  }

  const lookupContext = await resolveSessionStoreLookupContext({
    api,
    normalizedKey,
    sourceAgentId,
  });
  if (!lookupContext) {
    return unknownSessionIdentity();
  }

  const cacheKey = buildSessionMetadataCacheKey({
    normalizedKey,
    storePath: lookupContext.storePath,
  });
  const cached = sessionMetadataCache.get(cacheKey);
  if (cached?.data && cached.expiresAt && Date.now() < cached.expiresAt) {
    return cached.data;
  }
  if (cached?.promise) {
    return cached.promise;
  }

  const promise = readSessionIdentity({
    normalizedKey,
    internals: lookupContext.internals,
    storePath: lookupContext.storePath,
  }).then((data) => {
    setSessionMetadataCache(cacheKey, data);
    return data;
  });
  setSessionMetadataCachePromise(cacheKey, promise);
  return promise;
}
