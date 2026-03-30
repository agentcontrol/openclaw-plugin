import { createRequire } from "node:module";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import register from "./agent-control-plugin.ts";

export const AGENT_CONTROL_PLUGIN_ID = "agent-control-openclaw-plugin";
export const AGENT_CONTROL_PLUGIN_NAME = "Agent Control";
export const AGENT_CONTROL_PLUGIN_DESCRIPTION =
  "Registers OpenClaw tools with Agent Control and blocks unsafe tool invocations.";

export type AgentControlPluginEntry = {
  id: string;
  name: string;
  description: string;
  register(api: OpenClawPluginApi): void;
};

type DefinePluginEntry = (entry: AgentControlPluginEntry) => AgentControlPluginEntry;
type RequireLike = (specifier: string) => unknown;
type CreateRequireLike = (path: string | URL) => RequireLike;

export const agentControlPluginEntry: AgentControlPluginEntry = {
  id: AGENT_CONTROL_PLUGIN_ID,
  name: AGENT_CONTROL_PLUGIN_NAME,
  description: AGENT_CONTROL_PLUGIN_DESCRIPTION,
  register,
};

function tryReadDefinePluginEntryFromModule(
  requireFn: RequireLike,
  specifier: string,
): DefinePluginEntry | null {
  try {
    const loaded = requireFn(specifier) as { definePluginEntry?: unknown };
    return typeof loaded.definePluginEntry === "function"
      ? (loaded.definePluginEntry as DefinePluginEntry)
      : null;
  } catch {
    return null;
  }
}

export function loadDefinePluginEntry(
  createRequireImpl: CreateRequireLike = createRequire as CreateRequireLike,
): DefinePluginEntry | null {
  const requireFn = createRequireImpl(import.meta.url);

  // Prefer the dedicated modern helper module when it exists, but also accept
  // the helper from core because some gateways exposed it there during the
  // migration window.
  return (
    tryReadDefinePluginEntryFromModule(requireFn, "openclaw/plugin-sdk/plugin-entry") ??
    tryReadDefinePluginEntryFromModule(requireFn, "openclaw/plugin-sdk/core")
  );
}

export function createPluginEntry(
  entry: AgentControlPluginEntry,
  definePluginEntry: DefinePluginEntry | null,
) {
  return definePluginEntry ? definePluginEntry(entry) : entry.register;
}

const definePluginEntry = loadDefinePluginEntry();

export default createPluginEntry(agentControlPluginEntry, definePluginEntry);
