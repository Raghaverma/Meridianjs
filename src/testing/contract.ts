import { describe, expect, it } from "vitest";
import type {
  AuthConfig,
  MeridianErrorCode,
  PaginationStrategy,
  ProviderAdapter,
  RawResponse,
} from "../core/types.js";
import { isRetryableByCode, MeridianError } from "../core/types.js";

/**
 * The frozen set of public error codes. Every error a provider adapter
 * produces must resolve to one of these via `MeridianError.code`.
 */
const VALID_ERROR_CODES: ReadonlySet<MeridianErrorCode> = new Set<MeridianErrorCode>([
  "AUTH_FAILED",
  "RATE_LIMITED",
  "NOT_FOUND",
  "BAD_REQUEST",
  "UPSTREAM_5XX",
  "NETWORK_ERROR",
  "TIMEOUT",
  "UNKNOWN",
]);

/** Build a synthetic HTTP error in the shape adapters expect from the pipeline. */
function httpError(status: number, body: unknown = {}, headers?: Record<string, string> | Headers) {
  return { status, headers: new Headers(headers), body };
}

export interface ContractOptions {
  /**
   * The provider name every error/response must report. Defaults to the
   * registry key passed as `providerName`. Override only when an adapter
   * intentionally reports a different canonical name.
   */
  expectedProviderName?: string;
}

/**
 * Runs the universal Meridian provider contract against a single adapter.
 *
 * This is the same battery every adapter must pass — adapters are just data
 * sources, so the guarantees Meridian makes (error normalization, retry
 * semantics, rate-limit parsing, pagination, request shaping) must hold
 * identically across all of them.
 *
 * Only provider-agnostic invariants are asserted here. Provider-specific
 * details (exact auth header format, vendor rate-limit header names, status
 * codes that legitimately differ between vendors such as 403/404) belong in
 * each provider's own `adapter.test.ts`.
 *
 * @example
 *   runProviderContract("stripe", new StripeAdapter());
 */
export function runProviderContract(
  providerName: string,
  adapter: ProviderAdapter,
  options: ContractOptions = {},
): void {
  const expectedProvider = options.expectedProviderName ?? providerName;

  describe(`Provider Contract: ${providerName}`, () => {
    // ── Request Metadata ─────────────────────────────────────────────
    describe("request metadata (buildRequest)", () => {
      it("returns a well-formed request envelope with an absolute URL", () => {
        const built = adapter.buildRequest({
          endpoint: "/contract-test",
          options: { method: "GET", query: { a: "1", b: 2 } },
          authToken: { token: "contract-token", secret: "contract-secret" },
        });

        expect(typeof built.url).toBe("string");
        expect(() => new URL(built.url)).not.toThrow();
        expect(built.method).toBe("GET");
        expect(built.headers).toBeTypeOf("object");
        expect(built.headers).not.toBeNull();
      });

      it("does not attach a body to GET requests", () => {
        const built = adapter.buildRequest({
          endpoint: "/contract-test",
          options: { method: "GET", body: { ignored: true } },
          authToken: { token: "contract-token", secret: "contract-secret" },
        });
        expect(built.body).toBeUndefined();
      });
    });

    // ── Auth Failure ─────────────────────────────────────────────────
    describe("auth failure", () => {
      it("rejects empty credentials with an auth-category MeridianError", async () => {
        await expect(adapter.authStrategy({} as AuthConfig)).rejects.toBeInstanceOf(MeridianError);
        try {
          await adapter.authStrategy({} as AuthConfig);
          throw new Error("authStrategy resolved with empty credentials");
        } catch (err) {
          const e = err as MeridianError;
          expect(e.category).toBe("auth");
          expect(e.provider).toBe(expectedProvider);
        }
      });
    });

    // ── Error Mapping + Retry semantics ──────────────────────────────
    describe("error mapping", () => {
      // Only universally-agreed status codes. 403/404/409/422 legitimately
      // differ between vendors and are covered in per-provider suites.
      const cases: Array<{ status: number; category: string; retryable: boolean }> = [
        { status: 401, category: "auth", retryable: false },
        { status: 429, category: "rate_limit", retryable: true },
        { status: 500, category: "provider", retryable: true },
        { status: 502, category: "provider", retryable: true },
        { status: 503, category: "provider", retryable: true },
      ];

      for (const c of cases) {
        it(`maps HTTP ${c.status} → ${c.category} (retryable=${c.retryable})`, () => {
          const err = adapter.parseError(httpError(c.status));
          expect(err).toBeInstanceOf(MeridianError);
          expect(err.category).toBe(c.category);
          expect(err.retryable).toBe(c.retryable);
          expect(err.provider).toBe(expectedProvider);
        });
      }

      it("always produces a canonical public error code", () => {
        for (const status of [401, 403, 404, 422, 429, 500, 503]) {
          const err = adapter.parseError(httpError(status));
          expect(VALID_ERROR_CODES.has(err.code)).toBe(true);
        }
      });

      it("keeps retryable consistent with the canonical code", () => {
        // The retry strategy trusts `retryable`; it must agree with what the
        // public error code implies, or retries diverge from documented behavior.
        for (const status of [401, 429, 500, 502, 503]) {
          const err = adapter.parseError(httpError(status));
          expect(err.retryable).toBe(isRetryableByCode(err.code));
        }
      });

      it("tags every error with the correct provider", () => {
        for (const status of [401, 429, 500]) {
          expect(adapter.parseError(httpError(status)).provider).toBe(expectedProvider);
        }
      });
    });

    // ── Rate Limit ───────────────────────────────────────────────────
    describe("rate limit", () => {
      it("maps 429 to a retryable rate_limit error", () => {
        const err = adapter.parseError(httpError(429, {}, { "Retry-After": "30" }));
        expect(err.category).toBe("rate_limit");
        expect(err.retryable).toBe(true);
      });

      it("returns numeric rate-limit info even when headers are absent", () => {
        const rl = adapter.rateLimitPolicy(new Headers());
        expect(typeof rl.limit).toBe("number");
        expect(typeof rl.remaining).toBe("number");
        expect(Number.isNaN(rl.limit)).toBe(false);
        expect(Number.isNaN(rl.remaining)).toBe(false);
        expect(rl.reset).toBeInstanceOf(Date);
      });
    });

    // ── Network Failure ──────────────────────────────────────────────
    describe("network failure", () => {
      it("maps a network error to a retryable network-category error", () => {
        const err = adapter.parseError(new Error("fetch failed: network error (ECONNRESET)"));
        expect(err.category).toBe("network");
        expect(err.retryable).toBe(true);
        expect(err.provider).toBe(expectedProvider);
      });
    });

    // ── Timeout ──────────────────────────────────────────────────────
    describe("timeout", () => {
      it("treats timeouts as retryable", () => {
        const err = adapter.parseError(new Error("request timed out (ETIMEDOUT)"));
        expect(err.retryable).toBe(true);
      });
    });

    // ── Pagination ───────────────────────────────────────────────────
    describe("pagination", () => {
      it("exposes a complete pagination strategy", () => {
        const strategy = adapter.paginationStrategy() as PaginationStrategy;
        for (const method of ["extractCursor", "extractTotal", "hasNext", "buildNextRequest"]) {
          expect(typeof (strategy as unknown as Record<string, unknown>)[method]).toBe("function");
        }
      });

      it("inspects a basic response without throwing", () => {
        const strategy = adapter.paginationStrategy();
        const raw: RawResponse = { status: 200, headers: new Headers(), body: {} };
        expect(() => strategy.hasNext(raw)).not.toThrow();
        expect(() => strategy.extractCursor(raw)).not.toThrow();
        expect(() => strategy.extractTotal(raw)).not.toThrow();
      });
    });

    // ── Response normalization ───────────────────────────────────────
    describe("response normalization (parseResponse)", () => {
      it("normalizes a success response to the Meridian envelope", () => {
        const raw: RawResponse = { status: 200, headers: new Headers(), body: { ok: true } };
        const normalized = adapter.parseResponse(raw);

        expect(normalized).toHaveProperty("data");
        expect(normalized).toHaveProperty("meta");
        expect(normalized.meta.provider).toBe(expectedProvider);
        expect(normalized.meta.rateLimit).toBeDefined();
        expect(normalized.meta.rateLimit.reset).toBeInstanceOf(Date);
        expect(typeof normalized.meta.rateLimit.limit).toBe("number");
        expect(Array.isArray(normalized.meta.warnings)).toBe(true);
        expect(typeof normalized.meta.schemaVersion).toBe("string");
      });
    });

    // ── Idempotency ──────────────────────────────────────────────────
    describe("idempotency config", () => {
      it("marks GET as a safe operation and exposes overrides as a Map", () => {
        const cfg = adapter.getIdempotencyConfig();
        expect(cfg.defaultSafeOperations.has("GET")).toBe(true);
        expect(cfg.operationOverrides).toBeInstanceOf(Map);
      });
    });
  });
}
