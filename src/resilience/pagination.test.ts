import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { RawResponse } from "../core/types.js";
import { CursorPaginationStrategy, OffsetPaginationStrategy } from "./pagination.js";

const raw = (body: unknown, headers: Record<string, string> = {}): RawResponse => {
  const h = new Headers();
  for (const [k, v] of Object.entries(headers)) h.set(k, v);
  return { status: 200, headers: h, body };
};

describe("OffsetPaginationStrategy", () => {
  it("advances while a total says there are more results", () => {
    const s = new OffsetPaginationStrategy("offset", "limit");
    expect(s.extractCursor(raw({ offset: 0, limit: 100, total: 250 }))).toBe("100");
    expect(s.hasNext(raw({ offset: 0, limit: 100, total: 250 }))).toBe(true);
  });

  it("stops once the total is reached", () => {
    const s = new OffsetPaginationStrategy("offset", "limit");
    expect(s.extractCursor(raw({ offset: 200, limit: 100, total: 250 }))).toBeNull();
    expect(s.hasNext(raw({ offset: 200, limit: 100, total: 250 }))).toBe(false);
  });

  it("stops on an empty page when no total is provided (no infinite advance)", () => {
    // Regression: without a total the strategy used to return a fresh, ever-
    // increasing offset forever, so hasNext never went false and the paginator
    // ran to its hard page cap (then threw).
    const s = new OffsetPaginationStrategy("offset", "limit");
    expect(s.hasNext(raw({ offset: 300, limit: 100, items: [] }))).toBe(false);
    expect(s.extractCursor(raw({ offset: 300, limit: 100, data: [] }))).toBeNull();
    expect(s.extractCursor(raw({ offset: 300, limit: 100, results: [] }))).toBeNull();
    expect(s.extractCursor(raw([]))).toBeNull();
  });

  it("keeps advancing on a non-empty page with no total", () => {
    const s = new OffsetPaginationStrategy("offset", "limit");
    expect(s.extractCursor(raw({ offset: 0, limit: 2, items: [1, 2] }))).toBe("2");
  });

  it("advances correctly across multiple pages when provider does not echo offset in response body", () => {
    // Regression: extractCursor read currentOffset from response.body.offset. If
    // the provider never echoes it, currentOffset was always 0, so every page
    // returned the same cursor ("100") and the cycle-detector fired on page 2.
    //
    // The fix threads offset through the strategy's own state, updated in
    // buildNextRequest so the following extractCursor call sees the correct base.
    const s = new OffsetPaginationStrategy("offset", "limit");
    const defaultLimit = 100;

    // Page 1 response — body has results but no offset field.
    const page1 = raw({ items: Array(defaultLimit).fill(1) });
    const cursor1 = s.extractCursor(page1);
    expect(cursor1).toBe("100"); // 0 + 100

    // Simulate the paginate loop calling buildNextRequest then fetching page 2.
    s.buildNextRequest("/items", {}, cursor1!);

    // Page 2 response — still no offset echoed.
    const page2 = raw({ items: Array(defaultLimit).fill(1) });
    const cursor2 = s.extractCursor(page2);
    expect(cursor2).toBe("200"); // must advance, not repeat "100"

    s.buildNextRequest("/items", {}, cursor2!);

    const page3 = raw({ items: Array(defaultLimit).fill(1) });
    expect(s.extractCursor(page3)).toBe("300");
  });

  it("buildNextRequest resolves limit from a numeric query value", () => {
    const s = new OffsetPaginationStrategy("offset", "limit");
    const { options } = s.buildNextRequest("/items", { query: { limit: 25 } }, "50");
    expect(options.query).toEqual({ limit: "25", offset: "50" });
  });

  it("buildNextRequest resolves limit from a string query value", () => {
    const s = new OffsetPaginationStrategy("offset", "limit");
    const { options } = s.buildNextRequest("/items", { query: { limit: "25" } }, "50");
    expect(options.query).toEqual({ limit: "25", offset: "50" });
  });

  it("buildNextRequest falls back to the default limit when none is given", () => {
    const s = new OffsetPaginationStrategy("offset", "limit", undefined, 40);
    const { endpoint, options } = s.buildNextRequest("/items", {}, "80");
    expect(endpoint).toBe("/items");
    expect(options.query).toEqual({ limit: "40", offset: "80" });
  });

  it("buildNextRequest preserves other options and query fields untouched", () => {
    const s = new OffsetPaginationStrategy("offset", "limit");
    const { options } = s.buildNextRequest(
      "/items",
      { method: "GET", query: { status: "active", limit: 10 } },
      "10",
    );
    expect(options).toMatchObject({
      method: "GET",
      query: { status: "active", limit: "10", offset: "10" },
    });
  });
});

describe("property: extractTotal never returns NaN from a malformed header", () => {
  // Regression: Number.parseInt("garbage", 10) is NaN, which is `!== null`
  // but compares false against every number. extractCursor's `>= total`
  // check would then never be true, so a malformed total header would never
  // signal end-of-results — pagination would run to the hard page cap
  // instead of stopping, on any provider response with a bad header.
  it("OffsetPaginationStrategy.extractTotal is never NaN for any header string", () => {
    fc.assert(
      fc.property(fc.string(), (headerValue) => {
        const s = new OffsetPaginationStrategy("offset", "limit", "X-Total-Count");
        const response = raw({ offset: 0, limit: 10 }, { "X-Total-Count": headerValue });
        const total = s.extractTotal(response);
        expect(Number.isNaN(total)).toBe(false);
      }),
      { numRuns: 200 },
    );
  });

  it("CursorPaginationStrategy.extractTotal is never NaN for any header string", () => {
    fc.assert(
      fc.property(fc.string(), (headerValue) => {
        const s = new CursorPaginationStrategy("X-Cursor", "cursor", "X-Total-Count");
        const h = new Headers();
        h.set("X-Total-Count", headerValue);
        const response: RawResponse = { status: 200, headers: h, body: {} };
        const total = s.extractTotal(response);
        expect(Number.isNaN(total)).toBe(false);
      }),
      { numRuns: 200 },
    );
  });

  it("a malformed total header no longer blocks termination (extractCursor falls back to empty-page detection)", () => {
    const s = new OffsetPaginationStrategy("offset", "limit", "X-Total-Count");
    const response = raw({ offset: 0, limit: 10, items: [] }, { "X-Total-Count": "not-a-number" });
    expect(s.extractCursor(response)).toBeNull();
    expect(s.hasNext(response)).toBe(false);
  });
});
