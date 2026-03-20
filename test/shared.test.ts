import { describe, expect, it } from "vitest";
import {
  asPositiveInt,
  asString,
  formatToolArgsForLog,
  hashSteps,
  sanitizeToolCatalogConfig,
  toJsonRecord,
} from "../src/shared.ts";

describe("shared utilities", () => {
  it("returns undefined for a blank string", () => {
    // Given a string that only contains whitespace
    const value = "   ";

    // When the string is normalized
    const normalized = asString(value);

    // Then the helper returns undefined
    expect(normalized).toBeUndefined();
  });

  it("floors a positive floating-point number", () => {
    // Given a positive floating-point number
    const value = 42.9;

    // When the number is normalized as a positive integer
    const normalized = asPositiveInt(value);

    // Then the fractional portion is discarded
    expect(normalized).toBe(42);
  });

  it("returns undefined for a non-record JSON value", () => {
    // Given a JSON value that is an array instead of an object record
    const value = ["not", "a", "record"];

    // When the value is coerced to a JSON record
    const record = toJsonRecord(value);

    // Then no record is returned
    expect(record).toBeUndefined();
  });

  it("forces plugins off while preserving sibling config", () => {
    // Given plugin config with plugins enabled and sibling settings present
    const config = {
      mode: "test",
      plugins: {
        enabled: true,
        keepMe: "yes",
      },
    };

    // When the tool catalog config is sanitized
    const sanitized = sanitizeToolCatalogConfig(config);

    // Then plugins are forced off and unrelated settings are preserved
    expect(sanitized).toEqual({
      mode: "test",
      plugins: {
        enabled: false,
        keepMe: "yes",
      },
    });
  });

  it("returns a stable placeholder for unserializable arguments", () => {
    // Given a circular argument payload that cannot be JSON serialized
    const circular: { self?: unknown } = {};
    circular.self = circular;

    // When the payload is formatted for logging
    const formatted = formatToolArgsForLog(circular);

    // Then a stable placeholder string is returned
    expect(formatted).toBe("[unserializable]");
  });

  it("produces the same digest for identical steps", () => {
    // Given the same step list hashed twice
    const steps = [{ type: "tool" as const, name: "shell" }];

    // When digests are computed for both hashes
    const first = hashSteps(steps);
    const second = hashSteps(steps);

    // Then both digests are identical
    expect(first).toBe(second);
  });
});
