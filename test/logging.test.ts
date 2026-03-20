import { describe, expect, it, vi } from "vitest";
import { createPluginLogger, resolveLogLevel } from "../src/logging.ts";

describe("resolveLogLevel", () => {
  it("defaults to warn", () => {
    expect(resolveLogLevel({})).toBe("warn");
  });

  it("uses an explicit logLevel when provided", () => {
    expect(resolveLogLevel({ logLevel: "info" })).toBe("info");
    expect(resolveLogLevel({ logLevel: "debug" })).toBe("debug");
  });

  it("lets logLevel override the deprecated debug flag", () => {
    expect(resolveLogLevel({ logLevel: "warn", debug: true })).toBe("warn");
  });

  it("falls back to the deprecated debug flag when logLevel is invalid", () => {
    expect(resolveLogLevel({ logLevel: "verbose" as never, debug: true })).toBe("debug");
  });
});

describe("createPluginLogger", () => {
  it("only emits warnings in warn mode", () => {
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

  it("emits info logs in info mode but still suppresses debug traces", () => {
    const info = vi.fn();
    const warn = vi.fn();
    const logger = createPluginLogger({ info, warn }, "info");

    logger.info("info");
    logger.debug("debug");

    expect(info.mock.calls).toEqual([["info"]]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("emits both info and debug logs in debug mode", () => {
    const info = vi.fn();
    const warn = vi.fn();
    const logger = createPluginLogger({ info, warn }, "debug");

    logger.info("info");
    logger.debug("debug");

    expect(info.mock.calls).toEqual([["info"], ["debug"]]);
    expect(warn).not.toHaveBeenCalled();
  });
});
