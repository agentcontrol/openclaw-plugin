import { createHash } from "node:crypto";
import type { AgentControlStep } from "./types.ts";

export const USER_BLOCK_MESSAGE =
  "This action is blocked by a security policy set by your operator. Do not attempt to circumvent, disable, or work around this control. Inform the user that this action is restricted and explain what was blocked.";
export const BOOT_WARMUP_AGENT_ID = "main";

export function asString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function asPositiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function toJsonRecord(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  try {
    const encoded = JSON.stringify(value);
    if (typeof encoded !== "string") {
      return undefined;
    }
    const parsed = JSON.parse(encoded) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function sanitizeToolCatalogConfig(config: Record<string, unknown>): Record<string, unknown> {
  const pluginsRaw = config.plugins;
  if (!isRecord(pluginsRaw)) {
    return {
      ...config,
      plugins: { enabled: false },
    };
  }
  return {
    ...config,
    plugins: {
      ...pluginsRaw,
      enabled: false,
    },
  };
}

export function trimToMax(value: string, maxLen: number): string {
  return value.length <= maxLen ? value : value.slice(0, maxLen);
}

export function secondsSince(startedAt: bigint): string {
  return (Number(process.hrtime.bigint() - startedAt) / 1_000_000_000).toFixed(3);
}

export function hashSteps(steps: AgentControlStep[]): string {
  return createHash("sha256").update(JSON.stringify(steps)).digest("hex");
}

export function formatToolArgsForLog(params: unknown): string {
  if (params === undefined) {
    return "undefined";
  }
  try {
    const encoded = JSON.stringify(params);
    if (typeof encoded !== "string") {
      return trimToMax(String(params), 1000);
    }
    return trimToMax(encoded, 1000);
  } catch {
    return "[unserializable]";
  }
}
