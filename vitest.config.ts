import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Coverage is opt-in via `npm run test:coverage` (and the CI coverage job).
    // Thresholds act as a no-regression ratchet: they sit just below the
    // current measured coverage, so any drop fails the build. Raise them as
    // coverage improves — never lower them to make a red build pass.
    //
    // Re-baselined for @vitest/coverage-v8 v4, which counts statements
    // differently from v1 (~6.6k vs ~24k tracked statements), so the absolute
    // percentages shifted. Measured on Node 20 (the gate): statements 79.03,
    // branches 72.41, functions 81.9, lines 80.29. Thresholds sit ~1pt below to
    // absorb cross-Node-version v8 variance and avoid flaky red builds.
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "html", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/*.d.ts", "src/providers/contract.test.ts"],
      thresholds: {
        statements: 78,
        branches: 71,
        functions: 80,
        lines: 79,
      },
    },
  },
});
