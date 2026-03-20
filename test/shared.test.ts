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
  it("Given a blank string, when it is normalized, then undefined is returned", () => {
    expect(asString("   ")).toBeUndefined();
  });

  it("Given a positive floating-point number, when it is normalized, then it is floored to a positive integer", () => {
    expect(asPositiveInt(42.9)).toBe(42);
  });

  it("Given a non-record value, when it is serialized as a JSON record, then undefined is returned", () => {
    expect(toJsonRecord(["not", "a", "record"])).toBeUndefined();
  });

  it("Given a plugin config with plugins enabled, when the tool catalog config is sanitized, then plugins are forced off and sibling fields are preserved", () => {
    expect(
      sanitizeToolCatalogConfig({
        mode: "test",
        plugins: {
          enabled: true,
          keepMe: "yes",
        },
      }),
    ).toEqual({
      mode: "test",
      plugins: {
        enabled: false,
        keepMe: "yes",
      },
    });
  });

  it("Given an unserializable argument payload, when it is formatted for logs, then a stable placeholder is returned", () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;

    expect(formatToolArgsForLog(circular)).toBe("[unserializable]");
  });

  it("Given two identical step arrays, when they are hashed, then they produce the same digest", () => {
    const steps = [{ type: "tool" as const, name: "shell" }];

    expect(hashSteps(steps)).toBe(hashSteps(steps));
  });
});
