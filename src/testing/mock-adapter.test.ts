import { beforeEach, describe, expect, it } from "vitest";
import { MeridianError } from "../core/types.js";
import { Fixtures } from "./fixtures.js";
import { MockAdapter } from "./mock-adapter.js";
import type { MockCall, MockHandler, MockResponse } from "./mock-adapter.js";

// ─── helpers ────────────────────────────────────────────────────────────────

function makeOptions(overrides: Parameters<typeof Object.assign>[1] = {}) {
  return Object.assign({ method: "GET" as const }, overrides);
}

function makeAdapterInput(endpoint: string, opts: Record<string, unknown> = {}) {
  return {
    endpoint,
    options: makeOptions(opts),
    authToken: { token: "mock-token" },
  };
}

// ─── onRequest ───────────────────────────────────────────────────────────────

describe("MockAdapter.onRequest", () => {
  let adapter: MockAdapter;

  beforeEach(() => {
    adapter = new MockAdapter("test-provider");
  });

  it("matches by exact string endpoint", async () => {
    adapter.onRequest({ endpoint: "/orders" }, () => ({ status: 201, body: { matched: true } }));

    const raw = await adapter.resolve("GET", "/orders", makeOptions());
    expect(raw.status).toBe(201);
    expect(raw.body).toEqual({ matched: true });
  });

  it("matches by RegExp endpoint", async () => {
    adapter.onRequest({ endpoint: /^\/orders\/\d+$/ }, () => ({
      status: 200,
      body: { regex: true },
    }));

    const raw = await adapter.resolve("GET", "/orders/42", makeOptions());
    expect(raw.body).toEqual({ regex: true });

    // should NOT match a different path
    const noMatch = await adapter.resolve("GET", "/orders/abc", makeOptions());
    expect(noMatch.body).toEqual({ mock: true, provider: "test-provider" });
  });

  it("matches by method", async () => {
    adapter.onRequest({ method: "POST", endpoint: "/items" }, () => ({
      status: 201,
      body: { created: true },
    }));

    // GET to same endpoint should fall through to default
    const getRes = await adapter.resolve("GET", "/items", makeOptions());
    expect(getRes.body).toEqual({ mock: true, provider: "test-provider" });

    // POST should match
    const postRes = await adapter.resolve("POST", "/items", makeOptions({ method: "POST" }));
    expect(postRes.status).toBe(201);
  });

  it("later registrations take precedence (unshift order)", async () => {
    adapter.onRequest({ endpoint: "/ping" }, () => ({ status: 200, body: { v: 1 } }));
    adapter.onRequest({ endpoint: "/ping" }, () => ({ status: 200, body: { v: 2 } }));

    const raw = await adapter.resolve("GET", "/ping", makeOptions());
    // second registration was unshifted, so it wins
    expect((raw.body as Record<string, unknown>).v).toBe(2);
  });

  it("handler without method/endpoint wildcard matches everything", async () => {
    adapter.onRequest({}, () => ({ status: 204 }));

    const raw = await adapter.resolve("DELETE", "/anything", makeOptions({ method: "DELETE" }));
    expect(raw.status).toBe(204);
  });
});

// ─── resolve ─────────────────────────────────────────────────────────────────

describe("MockAdapter.resolve", () => {
  let adapter: MockAdapter;

  beforeEach(() => {
    adapter = new MockAdapter("acme");
  });

  it("records calls with method, endpoint, options, and a Date timestamp", async () => {
    const before = new Date();
    await adapter.resolve("GET", "/users", makeOptions({ query: { page: "1" } }));
    const after = new Date();

    expect(adapter.calls).toHaveLength(1);
    const call: MockCall = adapter.calls[0];
    expect(call.method).toBe("GET");
    expect(call.endpoint).toBe("/users");
    expect(call.options.query).toEqual({ page: "1" });
    expect(call.timestamp).toBeInstanceOf(Date);
    expect(call.timestamp.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(call.timestamp.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it("returns a RawResponse with status/headers/body", async () => {
    const raw = await adapter.resolve("GET", "/anything", makeOptions());
    expect(typeof raw.status).toBe("number");
    expect(raw.headers).toBeInstanceOf(Headers);
    expect(raw.body).toBeDefined();
  });

  it("default unmatched request returns status 200 with { mock: true, provider }", async () => {
    const raw = await adapter.resolve("GET", "/not-registered", makeOptions());
    expect(raw.status).toBe(200);
    expect(raw.body).toEqual({ mock: true, provider: "acme" });
  });

  it("accumulates multiple calls", async () => {
    await adapter.resolve("GET", "/a", makeOptions());
    await adapter.resolve("POST", "/b", makeOptions({ method: "POST" }));
    expect(adapter.calls).toHaveLength(2);
    expect(adapter.calls[0].endpoint).toBe("/a");
    expect(adapter.calls[1].endpoint).toBe("/b");
  });
});

// ─── simulateError ────────────────────────────────────────────────────────────

describe("MockAdapter.simulateError", () => {
  let adapter: MockAdapter;

  beforeEach(() => {
    adapter = new MockAdapter("erp");
  });

  it("throws a MeridianError with the given category, status, and retryable flag", async () => {
    adapter.simulateError(
      { endpoint: "/fail" },
      { message: "Boom", category: "auth", status: 401, retryable: false },
    );

    await expect(adapter.resolve("GET", "/fail", makeOptions())).rejects.toBeInstanceOf(
      MeridianError,
    );

    let caught: MeridianError | null = null;
    try {
      await adapter.resolve("GET", "/fail", makeOptions());
    } catch (e) {
      caught = e as MeridianError;
    }

    expect(caught).not.toBeNull();
    expect(caught?.category).toBe("auth");
    expect(caught?.status).toBe(401);
    expect(caught?.retryable).toBe(false);
    expect(caught?.message).toBe("Boom");
  });

  it("uses provider category and retryable=false when not specified", async () => {
    adapter.simulateError({ endpoint: "/kaboom" }, { message: "error" });

    let caught: MeridianError | null = null;
    try {
      await adapter.resolve("GET", "/kaboom", makeOptions());
    } catch (e) {
      caught = e as MeridianError;
    }

    expect(caught?.category).toBe("provider");
    expect(caught?.retryable).toBe(false);
    expect(caught?.provider).toBe("erp");
  });

  it("still records the call before throwing", async () => {
    adapter.simulateError({ endpoint: "/err" }, { message: "x" });
    try {
      await adapter.resolve("GET", "/err", makeOptions());
    } catch {
      // expected
    }
    expect(adapter.calls).toHaveLength(1);
  });
});

// ─── simulateDelay ────────────────────────────────────────────────────────────

describe("MockAdapter.simulateDelay", () => {
  it("resolves after the configured delay and still returns a RawResponse", async () => {
    const adapter = new MockAdapter("slow");
    adapter.simulateDelay(5);

    const raw = await adapter.resolve("GET", "/slow", makeOptions());
    expect(raw.status).toBe(200);
  });

  it("reset() clears the delay so subsequent calls are not delayed", async () => {
    const adapter = new MockAdapter("slow");
    adapter.simulateDelay(5);
    adapter.reset();

    // Should still work with no delay
    const raw = await adapter.resolve("GET", "/fast", makeOptions());
    expect(raw.status).toBe(200);
  });
});

// ─── reset ────────────────────────────────────────────────────────────────────

describe("MockAdapter.reset", () => {
  it("clears calls", async () => {
    const adapter = new MockAdapter();
    await adapter.resolve("GET", "/a", makeOptions());
    expect(adapter.calls).toHaveLength(1);
    adapter.reset();
    expect(adapter.calls).toHaveLength(0);
  });

  it("clears registered handlers", async () => {
    const adapter = new MockAdapter();
    adapter.onRequest({ endpoint: "/custom" }, () => ({ status: 418 }));
    adapter.reset();

    const raw = await adapter.resolve("GET", "/custom", makeOptions());
    // handler was cleared; should get default
    expect(raw.status).toBe(200);
    expect(raw.body).toEqual({ mock: true, provider: "mock" });
  });

  it("returns this for chaining", () => {
    const adapter = new MockAdapter();
    expect(adapter.reset()).toBe(adapter);
  });
});

// ─── buildRequest ─────────────────────────────────────────────────────────────

describe("MockAdapter.buildRequest", () => {
  let adapter: MockAdapter;

  beforeEach(() => {
    adapter = new MockAdapter("builder");
  });

  it("produces a URL from the endpoint", () => {
    const built = adapter.buildRequest(makeAdapterInput("/payments"));
    expect(built.url).toContain("/payments");
  });

  it("appends query params to the URL", () => {
    const built = adapter.buildRequest({
      ...makeAdapterInput("/search"),
      options: makeOptions({ query: { q: "test", limit: 10 } }),
    });
    const url = new URL(built.url);
    expect(url.searchParams.get("q")).toBe("test");
    expect(url.searchParams.get("limit")).toBe("10");
  });

  it("sets Authorization Bearer header from the auth token", () => {
    const built = adapter.buildRequest({
      endpoint: "/secure",
      options: makeOptions(),
      authToken: { token: "secret-abc" },
    });
    expect(built.headers.Authorization).toBe("Bearer secret-abc");
  });

  it("JSON-stringifies body for non-GET requests", () => {
    const body = { amount: 100, currency: "USD" };
    const built = adapter.buildRequest({
      endpoint: "/charge",
      options: makeOptions({ method: "POST", body }),
      authToken: { token: "tok" },
    });
    expect(built.body).toBe(JSON.stringify(body));
  });

  it("omits body for GET requests with no body", () => {
    const built = adapter.buildRequest(makeAdapterInput("/data"));
    expect(built.body).toBeUndefined();
  });

  it("uses baseUrl override when provided", () => {
    const built = adapter.buildRequest({
      ...makeAdapterInput("/v1/test"),
      baseUrl: "https://api.example.com",
    });
    expect(built.url).toContain("api.example.com");
  });
});

// ─── parseResponse ────────────────────────────────────────────────────────────

describe("MockAdapter.parseResponse", () => {
  it("returns a NormalizedResponse with meta.provider equal to constructor providerName", () => {
    const adapter = new MockAdapter("razorpay");
    const raw = {
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      body: { id: "ord_123" },
    };

    const normalized = adapter.parseResponse(raw);
    expect(normalized.meta.provider).toBe("razorpay");
    expect(normalized.data).toEqual({ id: "ord_123" });
  });

  it("includes rateLimit in meta", () => {
    const adapter = new MockAdapter();
    const raw = {
      status: 200,
      headers: new Headers(),
      body: {},
    };

    const normalized = adapter.parseResponse(raw);
    expect(normalized.meta.rateLimit).toBeDefined();
    expect(normalized.meta.rateLimit.limit).toBe(1000);
    expect(normalized.meta.rateLimit.remaining).toBe(999);
  });

  it("includes a string requestId in meta", () => {
    const adapter = new MockAdapter();
    const raw = { status: 200, headers: new Headers(), body: {} };
    const normalized = adapter.parseResponse(raw);
    expect(typeof normalized.meta.requestId).toBe("string");
    expect(normalized.meta.requestId.length).toBeGreaterThan(0);
  });
});

// ─── parseError ───────────────────────────────────────────────────────────────

describe("MockAdapter.parseError", () => {
  const adapter = new MockAdapter("stripe");

  it("returns the same MeridianError instance when passed one", () => {
    const err = new MeridianError("original", "auth", "stripe", false);
    expect(adapter.parseError(err)).toBe(err);
  });

  it("wraps a plain Error in a MeridianError", () => {
    const plain = new Error("something went wrong");
    const wrapped = adapter.parseError(plain);
    expect(wrapped).toBeInstanceOf(MeridianError);
    expect(wrapped.message).toBe("something went wrong");
    expect(wrapped.provider).toBe("stripe");
    expect(wrapped.category).toBe("provider");
  });

  it("wraps a non-error value (string) in a MeridianError", () => {
    const wrapped = adapter.parseError("unexpected string");
    expect(wrapped).toBeInstanceOf(MeridianError);
    expect(wrapped.message).toBe("unexpected string");
  });

  it("wraps a non-error value (number)", () => {
    const wrapped = adapter.parseError(500);
    expect(wrapped).toBeInstanceOf(MeridianError);
    expect(wrapped.message).toBe("500");
  });
});

// ─── authStrategy ─────────────────────────────────────────────────────────────

describe("MockAdapter.authStrategy", () => {
  it("returns { token: 'mock-token' }", async () => {
    const adapter = new MockAdapter();
    const token = await adapter.authStrategy({});
    expect(token).toEqual({ token: "mock-token" });
  });
});

// ─── getIdempotencyConfig ─────────────────────────────────────────────────────

describe("MockAdapter.getIdempotencyConfig", () => {
  it("returns defaultSafeOperations containing GET, HEAD, OPTIONS", () => {
    const adapter = new MockAdapter();
    const config = adapter.getIdempotencyConfig();
    expect(config.defaultSafeOperations).toBeInstanceOf(Set);
    expect(config.defaultSafeOperations.has("GET")).toBe(true);
    expect(config.defaultSafeOperations.has("HEAD")).toBe(true);
    expect(config.defaultSafeOperations.has("OPTIONS")).toBe(true);
  });

  it("returns operationOverrides as a Map", () => {
    const adapter = new MockAdapter();
    const config = adapter.getIdempotencyConfig();
    expect(config.operationOverrides).toBeInstanceOf(Map);
  });
});

// ─── paginationStrategy ───────────────────────────────────────────────────────

describe("MockAdapter.paginationStrategy", () => {
  const adapter = new MockAdapter();
  const strategy = adapter.paginationStrategy();
  const fakeRaw = { status: 200, headers: new Headers(), body: {} };

  it("hasNext() returns false", () => {
    expect(strategy.hasNext(fakeRaw)).toBe(false);
  });

  it("extractCursor() returns null", () => {
    expect(strategy.extractCursor(fakeRaw)).toBeNull();
  });

  it("extractTotal() returns null", () => {
    expect(strategy.extractTotal(fakeRaw)).toBeNull();
  });

  it("buildNextRequest passes through endpoint and options unchanged", () => {
    const opts = makeOptions({ query: { page: "2" } });
    const result = strategy.buildNextRequest("/items", opts, "cursor-xyz");
    expect(result.endpoint).toBe("/items");
    expect(result.options).toBe(opts);
  });
});

// ─── Type contract: MockCall, MockHandler, MockResponse ───────────────────────

describe("Exported types (compile-time shape checks)", () => {
  it("MockCall shape has method, endpoint, options, timestamp", async () => {
    const adapter = new MockAdapter();
    await adapter.resolve("GET", "/typed", makeOptions());
    const call: MockCall = adapter.calls[0];
    expect(typeof call.method).toBe("string");
    expect(typeof call.endpoint).toBe("string");
    expect(call.options).toBeDefined();
    expect(call.timestamp).toBeInstanceOf(Date);
  });

  it("MockHandler type allows method/endpoint/handler", () => {
    const h: MockHandler = {
      method: "POST",
      endpoint: "/foo",
      handler: async () => ({ status: 200 }),
    };
    expect(h.method).toBe("POST");
  });

  it("MockResponse type allows status, headers, body", () => {
    const r: MockResponse = { status: 200, headers: { "x-id": "1" }, body: { ok: true } };
    expect(r.status).toBe(200);
  });
});

// ─── Fixtures ─────────────────────────────────────────────────────────────────

describe("Fixtures", () => {
  describe("Fixtures.razorpay", () => {
    it("order() returns MockResponse with status 200 and expected fields", () => {
      const f = Fixtures.razorpay.order();
      expect(f.status).toBe(200);
      expect((f.body as Record<string, unknown>).id).toBe("order_mock123");
      expect((f.body as Record<string, unknown>).entity).toBe("order");
    });

    it("order() merges overrides", () => {
      const f = Fixtures.razorpay.order({ amount: 99999, status: "paid" });
      expect((f.body as Record<string, unknown>).amount).toBe(99999);
      expect((f.body as Record<string, unknown>).status).toBe("paid");
    });

    it("payment() returns MockResponse with status 200 and expected fields", () => {
      const f = Fixtures.razorpay.payment();
      expect(f.status).toBe(200);
      expect((f.body as Record<string, unknown>).id).toBe("pay_mock123");
    });

    it("rateLimitExceeded() returns status 429 with retry-after header", () => {
      const f = Fixtures.razorpay.rateLimitExceeded();
      expect(f.status).toBe(429);
      expect(f.headers?.["retry-after"]).toBe("30");
    });
  });

  describe("Fixtures.cashfree", () => {
    it("order() returns MockResponse with cf_order_id", () => {
      const f = Fixtures.cashfree.order();
      expect(f.status).toBe(200);
      expect((f.body as Record<string, unknown>).cf_order_id).toBe("mock_cf_123");
    });

    it("order() merges overrides", () => {
      const f = Fixtures.cashfree.order({ order_status: "PAID" });
      expect((f.body as Record<string, unknown>).order_status).toBe("PAID");
    });
  });

  describe("Fixtures.stripe", () => {
    it("paymentIntent() returns status 200 with object payment_intent", () => {
      const f = Fixtures.stripe.paymentIntent();
      expect(f.status).toBe(200);
      expect((f.body as Record<string, unknown>).object).toBe("payment_intent");
    });

    it("paymentIntent() merges overrides", () => {
      const f = Fixtures.stripe.paymentIntent({ status: "requires_action" });
      expect((f.body as Record<string, unknown>).status).toBe("requires_action");
    });
  });

  describe("Fixtures.generic", () => {
    it("ok() returns status 200 with { ok: true } by default", () => {
      const f = Fixtures.generic.ok();
      expect(f.status).toBe(200);
      expect(f.body).toEqual({ ok: true });
    });

    it("ok() accepts custom body", () => {
      const f = Fixtures.generic.ok({ data: [1, 2, 3] });
      expect(f.body).toEqual({ data: [1, 2, 3] });
    });

    it("notFound() returns status 404", () => {
      const f = Fixtures.generic.notFound();
      expect(f.status).toBe(404);
    });

    it("notFound() uses custom message", () => {
      const f = Fixtures.generic.notFound("Resource gone");
      expect((f.body as Record<string, unknown>).message).toBe("Resource gone");
    });

    it("serverError() returns status 500", () => {
      const f = Fixtures.generic.serverError();
      expect(f.status).toBe(500);
    });

    it("unauthorized() returns status 401", () => {
      const f = Fixtures.generic.unauthorized();
      expect(f.status).toBe(401);
    });

    it("rateLimited() returns status 429 with default retry-after of 30", () => {
      const f = Fixtures.generic.rateLimited();
      expect(f.status).toBe(429);
      expect(f.headers?.["retry-after"]).toBe("30");
    });

    it("rateLimited() uses custom retryAfter", () => {
      const f = Fixtures.generic.rateLimited(60);
      expect(f.headers?.["retry-after"]).toBe("60");
    });
  });

  describe("Fixtures used with MockAdapter.onRequest", () => {
    it("can wire a fixture to a handler and resolve it", async () => {
      const adapter = new MockAdapter("razorpay");
      adapter.onRequest({ method: "POST", endpoint: "/v1/orders" }, () =>
        Fixtures.razorpay.order(),
      );

      const raw = await adapter.resolve("POST", "/v1/orders", makeOptions({ method: "POST" }));
      expect(raw.status).toBe(200);
      expect((raw.body as Record<string, unknown>).id).toBe("order_mock123");
    });
  });
});
