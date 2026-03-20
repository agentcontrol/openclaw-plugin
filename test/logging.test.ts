import { describe, expect, it, vi } from "vitest";
import { createPluginLogger, resolveLogLevel } from "../src/logging.ts";

describe("resolveLogLevel", () => {
  it("Given no logging configuration, when the log level is resolved, then warn is used", () => {
    expect(resolveLogLevel({})).toBe("warn");
  });

  it("Given an explicit log level, when the log level is resolved, then the configured level is used", () => {
    expect(resolveLogLevel({ logLevel: "info" })).toBe("info");
    expect(resolveLogLevel({ logLevel: "debug" })).toBe("debug");
  });

  it("Given both logLevel and the deprecated debug flag, when the log level is resolved, then logLevel wins", () => {
    expect(resolveLogLevel({ logLevel: "warn", debug: true })).toBe("warn");
  });

  it("Given an invalid logLevel and debug=true, when the log level is resolved, then debug is used as a compatibility fallback", () => {
    expect(resolveLogLevel({ logLevel: "verbose" as never, debug: true })).toBe("debug");
  });
});

describe("createPluginLogger", () => {
  it("Given warn mode, when info and debug messages are emitted, then only warning-class messages are forwarded", () => {
    const info = vi.fn();
    const warn = vi.fn();
    const logger = createPluginLogger({ info, warn }, "warn");

    logger.info("info");
    logger.debug("debug");
    logger.warn("warn");
    logger.block("block");

    expect(info).not.toHaveBeenCalled();
    expect(warn.mock.calls).toEqual([["warn"], ["block"]]);
  });

  it("Given info mode, when info and debug messages are emitted, then lifecycle info is forwarded and debug traces stay suppressed", () => {
    const info = vi.fn();
    const warn = vi.fn();
    const logger = createPluginLogger({ info, warn }, "info");

    logger.info("info");
    logger.debug("debug");

    expect(info.mock.calls).toEqual([["info"]]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("Given debug mode, when info and debug messages are emitted, then both are forwarded", () => {
    const info = vi.fn();
    const warn = vi.fn();
    const logger = createPluginLogger({ info, warn }, "debug");

    logger.info("info");
    logger.debug("debug");

    expect(info.mock.calls).toEqual([["info"], ["debug"]]);
    expect(warn).not.toHaveBeenCalled();
  });
});
