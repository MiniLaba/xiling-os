import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/server/src/**/*.test.ts", "apps/web/src/**/*.test.ts", "scripts/**/*.test.mjs"],
    exclude: ["**/dist/**", "**/node_modules/**"],
  },
});
