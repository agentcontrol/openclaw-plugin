import { asString } from "./shared.ts";
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
  if (cfg.debug === true) {
    return "debug";
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
