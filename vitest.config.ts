import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false,
    coverage: {
      provider: "v8",
      all: true,
      reporter: ["text", "html", "json-summary", "lcov"],
      reportsDirectory: "./coverage",
      include: ["index.ts", "src/**/*.ts"],
      exclude: ["index.ts", "src/types.ts", "test/**/*.ts", "types/**/*.d.ts"],
    },
  },
});
