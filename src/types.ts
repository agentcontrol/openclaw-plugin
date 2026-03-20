import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";

export type LogLevel = "warn" | "info" | "debug";

export type AgentControlPluginConfig = {
  enabled?: boolean;
  serverUrl?: string;
  apiKey?: string;
  agentName?: string;
  agentId?: string;
  agentVersion?: string;
  timeoutMs?: number;
  userAgent?: string;
  failClosed?: boolean;
  logLevel?: LogLevel;
};

export type AgentControlStep = {
  type: "tool";
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

export type AgentState = {
  sourceAgentId: string;
  agentName: string;
  steps: AgentControlStep[];
  stepsHash: string;
  lastSyncedStepsHash: string | null;
  syncPromise: Promise<void> | null;
};

export type ChannelType = "direct" | "group" | "channel" | "unknown";

export type DerivedChannelContext = {
  provider: string | null;
  type: ChannelType;
  scope: string | null;
  source: "sessionKey" | "unknown";
};

export type ToolCatalogInternals = {
  createOpenClawCodingTools: (params: {
    agentId: string;
    sessionKey?: string;
    sessionId?: string;
    runId?: string;
    config: OpenClawPluginApi["config"];
    senderIsOwner: boolean;
  }) => unknown[];
  toToolDefinitions: (tools: unknown[]) => Array<{
    name: string;
    label?: string;
    description?: string;
    parameters?: unknown;
  }>;
};

export type SessionStoreInternals = {
  loadConfig: () => Record<string, unknown>;
  resolveStorePath: (storePath?: string) => string;
  loadSessionStore: (storePath: string) => Record<string, unknown>;
};

export type SessionIdentitySnapshot = {
  provider: string | null;
  type: ChannelType;
  channelName: string | null;
  dmUserName: string | null;
  label: string | null;
  from: string | null;
  to: string | null;
  accountId: string | null;
  source: "sessionStore" | "unknown";
};

export type SessionMetadataCacheEntry = {
  at: number;
  data: SessionIdentitySnapshot;
};

export type LoggerLike = Pick<OpenClawPluginApi["logger"], "info" | "warn">;

export type PluginLogger = {
  info: (message: string) => void;
  debug: (message: string) => void;
  warn: (message: string) => void;
  block: (message: string) => void;
};

export type ToolCatalogBundleBuildInfo = {
  bundlePath: string;
  cacheDir: string;
  cacheKey: string;
  openClawRoot: string;
  wrapperEntryPath: string;
  metaPath: string;
};

export type ResolveStepsForContextParams = {
  api: OpenClawPluginApi;
  logger: PluginLogger;
  sourceAgentId: string;
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
};
