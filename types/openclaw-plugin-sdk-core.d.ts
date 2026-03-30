declare module "openclaw/plugin-sdk/core" {
  export type OpenClawApprovalRequest = {
    title: string;
    description: string;
    severity: "warning";
    timeoutMs: number;
    timeoutBehavior: "deny";
  };

  export type OpenClawBeforeToolCallResult = {
    block?: boolean;
    blockReason?: string;
    requireApproval?: OpenClawApprovalRequest;
  };

  export type OpenClawBeforeToolCallEvent = {
    toolName: string;
    params?: unknown;
    runId?: string;
    toolCallId?: string;
  };

  export type OpenClawBeforeToolCallContext = {
    agentId?: string;
    sessionKey?: string;
    sessionId?: string;
    runId?: string;
    toolCallId?: string;
  };

  export interface OpenClawPluginApi {
    id: string;
    version?: string;
    config: Record<string, unknown>;
    pluginConfig?: unknown;
    logger: {
      info(message: string): void;
      warn(message: string): void;
    };
    on(event: "gateway_start", handler: () => void | Promise<void>): void;
    on(
      event: "before_tool_call",
      handler: (
        event: OpenClawBeforeToolCallEvent,
        ctx: OpenClawBeforeToolCallContext,
      ) => OpenClawBeforeToolCallResult | void | Promise<OpenClawBeforeToolCallResult | void>,
    ): void;
    on(event: string, handler: (...args: any[]) => unknown): void;
  }
}
