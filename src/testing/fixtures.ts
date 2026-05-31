import type { MockResponse } from "./mock-adapter.js";

export const Fixtures = {
  razorpay: {
    order: (overrides?: Record<string, unknown>): MockResponse => ({
      status: 200,
      body: {
        id: "order_mock123",
        entity: "order",
        amount: 50000,
        currency: "INR",
        status: "created",
        ...overrides,
      },
    }),
    payment: (overrides?: Record<string, unknown>): MockResponse => ({
      status: 200,
      body: {
        id: "pay_mock123",
        entity: "payment",
        amount: 50000,
        currency: "INR",
        status: "captured",
        ...overrides,
      },
    }),
    rateLimitExceeded: (): MockResponse => ({
      status: 429,
      headers: { "retry-after": "30" },
      body: { error: { code: "BAD_REQUEST_ERROR", description: "Rate limit exceeded" } },
    }),
  },

  cashfree: {
    order: (overrides?: Record<string, unknown>): MockResponse => ({
      status: 200,
      body: {
        cf_order_id: "mock_cf_123",
        order_id: "order_mock",
        order_status: "ACTIVE",
        ...overrides,
      },
    }),
  },

  stripe: {
    paymentIntent: (overrides?: Record<string, unknown>): MockResponse => ({
      status: 200,
      body: {
        id: "pi_mock123",
        object: "payment_intent",
        amount: 1000,
        currency: "usd",
        status: "succeeded",
        ...overrides,
      },
    }),
  },

  generic: {
    ok: (body?: unknown): MockResponse => ({ status: 200, body: body ?? { ok: true } }),
    notFound: (message = "Not found"): MockResponse => ({ status: 404, body: { message } }),
    serverError: (message = "Internal Server Error"): MockResponse => ({
      status: 500,
      body: { message },
    }),
    unauthorized: (): MockResponse => ({ status: 401, body: { message: "Unauthorized" } }),
    rateLimited: (retryAfter = 30): MockResponse => ({
      status: 429,
      headers: { "retry-after": String(retryAfter) },
      body: { message: "Too many requests" },
    }),
  },
};
