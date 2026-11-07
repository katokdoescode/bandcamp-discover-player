import { defineConfig } from "vitest/config";
import { WxtVitest } from "wxt/testing/vitest-plugin";

// Live checks against bandcamp.com (tests/live): not part of `npm test`.
export default defineConfig({
  plugins: [WxtVitest()],
  test: {
    include: ["tests/live/**/*.monitor.ts"],
    testTimeout: 90_000,
    hookTimeout: 90_000,
    fileParallelism: false,
    reporters: ["default", "json"],
    outputFile: { json: "live-report/results.json" },
  },
});
