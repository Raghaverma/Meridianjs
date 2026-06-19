import { describe, expect, it } from "vitest";
import type { RawResponse } from "../core/types.js";
import { OffsetPaginationStrategy } from "./pagination.js";

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
});
