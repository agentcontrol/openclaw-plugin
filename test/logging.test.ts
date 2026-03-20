import { describe, expect, it, vi } from "vitest";
import { createPluginLogger, resolveLogLevel } from "../src/logging.ts";

describe("resolveLogLevel", () => {
  it("defaults to warn", () => {
    // Given
    const config = {};

    // When
    const level = resolveLogLevel(config);

    // Then
    expect(level).toBe("warn");
  });

  it("uses an explicit configured level", () => {
    // Given
    const infoConfig = { logLevel: "info" } as const;
    const debugConfig = { logLevel: "debug" } as const;

    // When
    const infoLevel = resolveLogLevel(infoConfig);
    const debugLevel = resolveLogLevel(debugConfig);

    // Then
    expect(infoLevel).toBe("info");
    expect(debugLevel).toBe("debug");
  });

  it("prefers logLevel over the deprecated debug flag", () => {
    // Given
    const config = { logLevel: "warn", debug: true } as const;

    // When
    const level = resolveLogLevel(config);

    // Then
    expect(level).toBe("warn");
  });

  it("falls back to debug for deprecated compatibility", () => {
    // Given
    const config = { logLevel: "verbose" as never, debug: true };

    // When
    const level = resolveLogLevel(config);

    // Then
    expect(level).toBe("debug");
  });
});

describe("createPluginLogger", () => {
  it("suppresses info and debug output in warn mode", () => {
    // Given
    const info = vi.fn();
    const warn = vi.fn();
    const logger = createPluginLogger({ info, warn }, "warn");

    // When
    logger.info("info");
    logger.debug("debug");
    logger.warn("warn");
    logger.block("block");

    // Then
    expect(info).not.toHaveBeenCalled();
    expect(warn.mock.calls).toEqual([["warn"], ["block"]]);
  });

  it("emits info but not debug output in info mode", () => {
    // Given
    const info = vi.fn();
    const warn = vi.fn();
    const logger = createPluginLogger({ info, warn }, "info");

    // When
    logger.info("info");
    logger.debug("debug");

    // Then
    expect(info.mock.calls).toEqual([["info"]]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("emits info and debug output in debug mode", () => {
    // Given
    const info = vi.fn();
    const warn = vi.fn();
    const logger = createPluginLogger({ info, warn }, "debug");

    // When
    logger.info("info");
    logger.debug("debug");

    // Then
    expect(info.mock.calls).toEqual([["info"], ["debug"]]);
    expect(warn).not.toHaveBeenCalled();
  });
});
