import type { LoggerLike, PluginLogger } from "./types.ts";

export function createPluginLogger(logger: LoggerLike, debugEnabled: boolean): PluginLogger {
  return {
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
