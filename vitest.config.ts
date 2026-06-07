import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Coverage is opt-in via `npm run test:coverage` (and the CI coverage job).
    // Thresholds act as a no-regression ratchet: they sit just below the
    // current measured coverage, so any drop fails the build. Raise them as
    // coverage improves — never lower them to make a red build pass.
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "html", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/*.d.ts", "src/providers/contract.test.ts"],
      thresholds: {
        statements: 84,
        branches: 80,
        functions: 82,
        lines: 84,
      },
    },
  },
});
