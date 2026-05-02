import { asString, isRecord } from "./shared.ts";
import type { AgentControlPluginConfig, LogLevel, LoggerLike, PluginLogger } from "./types.ts";

const LOG_LEVELS: LogLevel[] = ["warn", "info", "debug"];

function isLogLevel(value: string): value is LogLevel {
  return LOG_LEVELS.includes(value as LogLevel);
}

export function resolveLogLevel(cfg: AgentControlPluginConfig): LogLevel {
  const configuredLevel = asString(cfg.logLevel)?.toLowerCase();
  if (configuredLevel && isLogLevel(configuredLevel)) {
    return configuredLevel;
  }
  return "warn";
}

export function createPluginLogger(logger: LoggerLike, logLevel: LogLevel): PluginLogger {
  const infoEnabled = logLevel === "info" || logLevel === "debug";
  const debugEnabled = logLevel === "debug";
  return {
    info(message: string) {
      if (infoEnabled) {
        logger.info(message);
      }
    },
    debug(message: string) {
      if (debugEnabled) {
        logger.info(message);
      }
    },
    warn(message: string) {
      logger.warn(message);
    },
    block(message: string) {
      logger.warn(message);
    },
  };
}

function safeJsonStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function collectErrorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  const seen = new WeakSet<object>();
  let current: unknown = error;

  while (current !== undefined && current !== null) {
    chain.push(current);
    if (!isRecord(current) || !("cause" in current)) {
      break;
    }

    const cause = current.cause;
    if (typeof cause === "object" && cause !== null) {
      if (seen.has(cause)) {
        break;
      }
      seen.add(cause);
    }
    current = cause;
  }

  return chain;
}

function statusCodeFromResponse(response: unknown): string | undefined {
  if (response instanceof Response) {
    return String(response.status);
  }
  if (!isRecord(response)) {
    return undefined;
  }

  const status = response.status ?? response.statusCode;
  return typeof status === "number" || typeof status === "string" ? String(status) : undefined;
}

function extractStatusCode(errorChain: unknown[]): string | undefined {
  for (const error of errorChain) {
    if (!isRecord(error)) {
      continue;
    }

    const status = error.statusCode ?? error.status;
    if (typeof status === "number" || typeof status === "string") {
      return String(status);
    }

    for (const key of ["response$", "response", "rawResponse"]) {
      const response = error[key];
      const responseStatus = statusCodeFromResponse(response);
      if (responseStatus) {
        return responseStatus;
      }
    }
  }

  return undefined;
}

function formatResponseBody(value: unknown): string | undefined {
  if (typeof value === "string") {
    return asString(value);
  }
  return safeJsonStringify(value);
}

function extractResponseBody(errorChain: unknown[]): string | undefined {
  for (const error of errorChain) {
    if (!isRecord(error)) {
      continue;
    }

    for (const key of ["body", "body$"]) {
      const body = formatResponseBody(error[key]);
      if (body) {
        return body;
      }
    }
  }

  return undefined;
}

function fallbackErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (isRecord(error)) {
    const message = asString(error.message);
    if (message) {
      return message;
    }
  }
  return safeJsonStringify(error) ?? String(error);
}

export function formatAgentControlError(error: unknown): string {
  const errorChain = collectErrorChain(error);
  const details: string[] = [];
  const status = extractStatusCode(errorChain);
  const responseBody = extractResponseBody(errorChain);

  if (status) {
    details.push(`status=${status}`);
  }
  if (responseBody) {
    details.push(`response_body=${responseBody}`);
  }

  return details.length > 0 ? details.join(" ") : fallbackErrorMessage(error);
}
