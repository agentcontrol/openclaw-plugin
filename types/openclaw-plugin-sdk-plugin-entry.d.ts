declare module "openclaw/plugin-sdk/plugin-entry" {
  import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";

  export type OpenClawDefinedPluginEntry = {
    id: string;
    name: string;
    description?: string;
    register(api: OpenClawPluginApi): unknown;
  };

  export function definePluginEntry<TEntry extends OpenClawDefinedPluginEntry>(
    entry: TEntry,
  ): TEntry;
}
