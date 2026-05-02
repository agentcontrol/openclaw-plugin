import { describe, expect, it, vi } from "vitest";
import { createPluginLogger, formatAgentControlError, resolveLogLevel } from "../src/logging.ts";

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

describe("formatAgentControlError", () => {
  it("includes only HTTP status code and response body from SDK response errors", () => {
    // Given a generated SDK error object for a JSON error response
    const body = JSON.stringify({ detail: [{ loc: ["body", "agent"], msg: "invalid agent" }] });
    const error = {
      name: "HTTPValidationError",
      message: "Response validation failed",
      response$: new Response(body, {
        status: 422,
        statusText: "Unprocessable Entity",
        headers: { "content-type": "application/json" },
      }),
      body$: body,
    };

    // When the error is formatted for plugin logs
    const formatted = formatAgentControlError(error);

    // Then the log message preserves just the useful server response details
    expect(formatted).toBe(`status=422 response_body=${body}`);
  });

  it("includes HTTP status code and response body from direct SDK error fields", () => {
    // Given the concrete fields exposed by AgentControlSDKError subclasses
    const body = JSON.stringify({ detail: "server exploded" });
    const error = {
      name: "AgentControlSDKDefaultError",
      message: "API error occurred: Status 500. Body: server exploded",
      statusCode: 500,
      contentType: "application/json",
      body,
      rawResponse: new Response(body, {
        status: 500,
        statusText: "Internal Server Error",
        headers: { "content-type": "application/json" },
      }),
    };

    // When the error is formatted for plugin logs
    const formatted = formatAgentControlError(error);

    // Then direct SDK metadata is preserved without logging content type or status text
    expect(formatted).toBe(`status=500 response_body=${body}`);
  });

  it("includes HTTP details from wrapped SDK causes", () => {
    // Given a higher-level error wrapping the generated SDK error
    const error = new Error("unable to call Agent Control", {
      cause: {
        name: "AgentControlSDKDefaultError",
        message: "API error occurred",
        statusCode: 503,
        contentType: "text/plain",
        body: "service unavailable",
      },
    });

    // When the wrapper is formatted for plugin logs
    const formatted = formatAgentControlError(error);

    // Then details from the underlying cause are still included
    expect(formatted).toBe("status=503 response_body=service unavailable");
  });

  it("handles response-shaped status codes and object response bodies", () => {
    // Given a response-shaped error without direct SDK status fields
    const error = {
      response: { statusCode: 429 },
      body: { detail: "rate limited" },
    };

    // When the error is formatted for plugin logs
    const formatted = formatAgentControlError(error);

    // Then the response status and serialized body are logged
    expect(formatted).toBe('status=429 response_body={"detail":"rate limited"}');
  });

  it("falls back to concise messages for non-HTTP failures", () => {
    // Given non-SDK-shaped failures
    const plainError = new Error("network offline", { cause: "dns failure" });
    const objectError = { message: "bad config" };

    // When the errors are formatted for plugin logs
    const plainFormatted = formatAgentControlError(plainError);
    const objectFormatted = formatAgentControlError(objectError);
    const primitiveFormatted = formatAgentControlError("offline");

    // Then the regular error messages are preserved
    expect(plainFormatted).toBe("network offline");
    expect(objectFormatted).toBe("bad config");
    expect(primitiveFormatted).toBe('"offline"');
  });

  it("terminates circular error causes and handles unserializable fallback objects", () => {
    // Given circular error shapes
    const cause: Record<string, unknown> = { statusCode: 502, body: "bad gateway" };
    cause.cause = cause;
    const wrapper = new Error("outer", { cause });
    const circularFallback: Record<string, unknown> = {};
    circularFallback.self = circularFallback;

    // When they are formatted for plugin logs
    const wrappedFormatted = formatAgentControlError(wrapper);
    const fallbackFormatted = formatAgentControlError(circularFallback);

    // Then traversal stops safely and fallback serialization does not throw
    expect(wrappedFormatted).toBe("status=502 response_body=bad gateway");
    expect(fallbackFormatted).toBe("[object Object]");
  });
});
