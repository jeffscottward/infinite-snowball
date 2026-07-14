import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/e2e/**", "node_modules/**", "dist/**"],
    environment: "node",
    globals: false,
    clearMocks: true,
    restoreMocks: true,
    passWithNoTests: false,
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
