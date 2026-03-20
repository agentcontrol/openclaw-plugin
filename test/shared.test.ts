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
    // Given
    const value = "   ";

    // When
    const normalized = asString(value);

    // Then
    expect(normalized).toBeUndefined();
  });

  it("floors a positive floating-point number", () => {
    // Given
    const value = 42.9;

    // When
    const normalized = asPositiveInt(value);

    // Then
    expect(normalized).toBe(42);
  });

  it("returns undefined for a non-record JSON value", () => {
    // Given
    const value = ["not", "a", "record"];

    // When
    const record = toJsonRecord(value);

    // Then
    expect(record).toBeUndefined();
  });

  it("forces plugins off while preserving sibling config", () => {
    // Given
    const config = {
      mode: "test",
      plugins: {
        enabled: true,
        keepMe: "yes",
      },
    };

    // When
    const sanitized = sanitizeToolCatalogConfig(config);

    // Then
    expect(sanitized).toEqual({
      mode: "test",
      plugins: {
        enabled: false,
        keepMe: "yes",
      },
    });
  });

  it("returns a stable placeholder for unserializable arguments", () => {
    // Given
    const circular: { self?: unknown } = {};
    circular.self = circular;

    // When
    const formatted = formatToolArgsForLog(circular);

    // Then
    expect(formatted).toBe("[unserializable]");
  });

  it("produces the same digest for identical steps", () => {
    // Given
    const steps = [{ type: "tool" as const, name: "shell" }];

    // When
    const first = hashSteps(steps);
    const second = hashSteps(steps);

    // Then
    expect(first).toBe(second);
  });
});
