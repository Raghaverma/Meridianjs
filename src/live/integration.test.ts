import { describe, expect, it } from "vitest";
import { Meridian } from "../index.js";

/**
 * LIVE integration tests — exercise the FULL pipeline against real provider
 * sandboxes, not synthetic fixtures. This is the layer that proves the contract
 * holds end-to-end (auth → request shaping → real HTTP → error/rate-limit
 * normalization → trace), which unit tests with stubbed `fetch` cannot.
 *
 * OPT-IN ONLY. Skipped unless `MERIDIAN_LIVE_TESTS=1` AND the relevant sandbox
 * credentials are present, so normal `vitest run` / CI stays deterministic and
 * offline.
 *
 * Run:
 *   MERIDIAN_LIVE_TESTS=1 GITHUB_TOKEN=ghp_xxx \
 *   RAZORPAY_KEY_ID=rzp_test_xxx RAZORPAY_KEY_SECRET=xxx \
 *     npx vitest run src/live
 *
 * SAFETY: only READ (GET) endpoints are called — nothing is created, charged, or
 * mutated. Use SANDBOX / TEST credentials only (e.g. Razorpay `rzp_test_*`).
 */

const LIVE = process.env.MERIDIAN_LIVE_TESTS === "1";

interface LiveCase {
  /** Built-in provider name. */
  provider: string;
  /** Returns auth config from env, or null when the sandbox creds are absent. */
  creds: () => Record<string, unknown> | null;
  /** A safe, read-only endpoint that returns 200 with valid credentials. */
  readEndpoint: string;
  readQuery?: Record<string, string | number | boolean>;
}

const CASES: LiveCase[] = [
  {
    // Immediately runnable for most users — a GitHub token lists rate-limit info,
    // which also exercises live rate-limit header parsing.
    provider: "github",
    creds: () => (process.env.GITHUB_TOKEN ? { token: process.env.GITHUB_TOKEN } : null),
    readEndpoint: "/rate_limit",
  },
  {
    // Fintech wedge flagship — Razorpay test mode (rzp_test_* keys).
    provider: "razorpay",
    creds: () => {
      const username = process.env.RAZORPAY_KEY_ID;
      const password = process.env.RAZORPAY_KEY_SECRET;
      return username && password ? { username, password } : null;
    },
    readEndpoint: "/v1/payments",
    readQuery: { count: 1 },
  },
  // Add more India fintech sandboxes here (cashfree, payu, juspay, …) — same shape.
];

for (const c of CASES) {
  const creds = c.creds();
  describe.runIf(LIVE && creds !== null)(`LIVE: ${c.provider} sandbox`, () => {
    it("normalizes a real success through the full pipeline", async () => {
      const meridian = await Meridian.create({
        providers: { [c.provider]: { auth: creds as never } },
      });
      const client = meridian.provider(c.provider);
      expect(client).toBeDefined();

      const res = await client!.get(c.readEndpoint, c.readQuery ? { query: c.readQuery } : {});

      // Contract guarantees, verified against a real response:
      expect(res.meta.provider).toBe(c.provider);
      expect(res.meta.requestId).toBeTruthy();
      expect(res.meta.rateLimit).toBeDefined();
      expect(res.meta.rateLimit.reset).toBeInstanceOf(Date);
      expect(res.meta.trace).toBeDefined();
      expect(res.meta.trace?.latency).toBeGreaterThanOrEqual(0);
      expect(res.data).toBeDefined();
    });

    it("maps a real auth failure to a normalized error", async () => {
      const meridian = await Meridian.create({
        providers: {
          [c.provider]: {
            auth: {
              token: "definitely-invalid",
              apiKey: "definitely-invalid",
              username: "definitely-invalid",
              password: "definitely-invalid",
            } as never,
          },
        },
      });
      const client = meridian.provider(c.provider);
      await expect(client!.get(c.readEndpoint)).rejects.toMatchObject({
        // Bad credentials normalize to auth (or validation for providers that
        // 400 on a malformed key) — never an unhandled throw.
        category: expect.stringMatching(/^(auth|validation)$/),
      });
    });
  });
}

// Keeps the file meaningful (and self-documenting) when live tests are off.
describe("live integration harness", () => {
  it("is opt-in; set MERIDIAN_LIVE_TESTS=1 plus sandbox creds to enable", () => {
    expect(typeof LIVE).toBe("boolean");
    if (!LIVE) {
      expect(CASES.length).toBeGreaterThan(0);
    }
  });
});
