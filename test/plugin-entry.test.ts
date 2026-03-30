import { describe, expect, it, vi } from "vitest";
import {
  createPluginEntry,
  loadDefinePluginEntry,
  type AgentControlPluginEntry,
} from "../src/plugin-entry.ts";

describe("plugin entry compatibility", () => {
  it("returns the legacy register function when no modern helper is available", () => {
    // Given a plugin entry and a gateway without definePluginEntry support
    const legacyRegister = vi.fn();
    const entry: AgentControlPluginEntry = {
      id: "agent-control-openclaw-plugin",
      name: "Agent Control",
      description: "test entry",
      register: legacyRegister,
    };

    // When the plugin entry is created without a modern helper
    const resolved = createPluginEntry(entry, null);

    // Then the legacy raw register function is exported
    expect(resolved).toBe(legacyRegister);
  });

  it("wraps the entry with definePluginEntry when the helper is available", () => {
    // Given a plugin entry and a gateway that exposes definePluginEntry
    const legacyRegister = vi.fn();
    const entry: AgentControlPluginEntry = {
      id: "agent-control-openclaw-plugin",
      name: "Agent Control",
      description: "test entry",
      register: legacyRegister,
    };
    const definePluginEntry = vi.fn((value: AgentControlPluginEntry) => ({
      ...value,
      wrapped: true,
    }));

    // When the plugin entry is created with the helper
    const resolved = createPluginEntry(entry, definePluginEntry);

    // Then the modern helper receives the descriptor and its result is exported
    expect(definePluginEntry).toHaveBeenCalledWith(entry);
    expect(resolved).toEqual({
      ...entry,
      wrapped: true,
    });
  });

  it("prefers the dedicated plugin-entry module when it is present", () => {
    // Given a createRequire implementation that exposes the dedicated helper module
    const defineFromPluginEntry = vi.fn();
    const createRequireImpl = vi.fn(() =>
      vi.fn((specifier: string) => {
        if (specifier === "openclaw/plugin-sdk/plugin-entry") {
          return { definePluginEntry: defineFromPluginEntry };
        }
        throw new Error(`unexpected module lookup: ${specifier}`);
      }),
    );

    // When definePluginEntry is loaded from the gateway SDK
    const loaded = loadDefinePluginEntry(createRequireImpl);

    // Then the dedicated helper is returned without probing fallback modules
    expect(loaded).toBe(defineFromPluginEntry);
  });

  it("falls back to the core helper during the SDK migration window", () => {
    // Given a createRequire implementation without the dedicated helper module
    const defineFromCore = vi.fn();
    const requireFn = vi.fn((specifier: string) => {
      if (specifier === "openclaw/plugin-sdk/plugin-entry") {
        throw new Error("module not found");
      }
      if (specifier === "openclaw/plugin-sdk/core") {
        return { definePluginEntry: defineFromCore };
      }
      throw new Error(`unexpected module lookup: ${specifier}`);
    });

    // When definePluginEntry is loaded from the gateway SDK
    const loaded = loadDefinePluginEntry(vi.fn(() => requireFn));

    // Then the core-exported helper is used as a migration fallback
    expect(loaded).toBe(defineFromCore);
    expect(requireFn).toHaveBeenCalledWith("openclaw/plugin-sdk/plugin-entry");
    expect(requireFn).toHaveBeenCalledWith("openclaw/plugin-sdk/core");
  });

  it("returns null when neither modern helper is available", () => {
    // Given a createRequire implementation where both helper lookups fail
    const requireFn = vi.fn(() => {
      throw new Error("module not found");
    });

    // When definePluginEntry is loaded from the gateway SDK
    const loaded = loadDefinePluginEntry(vi.fn(() => requireFn));

    // Then the plugin can fall back to the legacy raw register export
    expect(loaded).toBeNull();
  });
});
