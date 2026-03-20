import { describe, expect, it, vi } from "vitest";
import { createPluginLogger, resolveLogLevel } from "../src/logging.ts";

describe("resolveLogLevel", () => {
  it("defaults to warn", () => {
    // Given no logging configuration is provided
    const config = {};

    // When the effective log level is resolved
    const level = resolveLogLevel(config);

    // Then warn mode is selected by default
    expect(level).toBe("warn");
  });

  it("uses an explicit configured level", () => {
    // Given explicit info and debug log level configurations
    const infoConfig = { logLevel: "info" } as const;
    const debugConfig = { logLevel: "debug" } as const;

    // When each configuration is resolved
    const infoLevel = resolveLogLevel(infoConfig);
    const debugLevel = resolveLogLevel(debugConfig);

    // Then the configured levels are preserved
    expect(infoLevel).toBe("info");
    expect(debugLevel).toBe("debug");
  });
});

describe("createPluginLogger", () => {
  it("suppresses info and debug output in warn mode", () => {
    // Given a logger configured for warn-only output
    const info = vi.fn();
    const warn = vi.fn();
    const logger = createPluginLogger({ info, warn }, "warn");

    // When info, debug, warn, and block messages are emitted
    logger.info("info");
    logger.debug("debug");
    logger.warn("warn");
    logger.block("block");

    // Then only warning-class messages are forwarded
    expect(info).not.toHaveBeenCalled();
    expect(warn.mock.calls).toEqual([["warn"], ["block"]]);
  });

  it("emits info but not debug output in info mode", () => {
    // Given a logger configured for info-level output
    const info = vi.fn();
    const warn = vi.fn();
    const logger = createPluginLogger({ info, warn }, "info");

    // When info and debug messages are emitted
    logger.info("info");
    logger.debug("debug");

    // Then only the info message is forwarded
    expect(info.mock.calls).toEqual([["info"]]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("emits info and debug output in debug mode", () => {
    // Given a logger configured for debug-level output
    const info = vi.fn();
    const warn = vi.fn();
    const logger = createPluginLogger({ info, warn }, "debug");

    // When info and debug messages are emitted
    logger.info("info");
    logger.debug("debug");

    // Then both messages are forwarded through the info channel
    expect(info.mock.calls).toEqual([["info"], ["debug"]]);
    expect(warn).not.toHaveBeenCalled();
  });
});
