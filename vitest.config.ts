import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    pool: "forks",
    testTimeout: 15000,
    env: { LOG_LEVEL: "silent" }
  }
});
