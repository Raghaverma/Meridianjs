import type { PaginationStrategy, RawResponse, RequestOptions } from "../../core/types.js";

export class CheckoutPaginationStrategy implements PaginationStrategy {
  extractCursor(response: RawResponse): string | null {
    if (typeof response.body === "object" && response.body !== null) {
      const b = response.body as Record<string, unknown>;
      // Checkout.com uses limit/skip with next/previous
      if (typeof b.next === "string" && b.next) return b.next;
      if (Array.isArray(b.data) && b.data.length > 0) return String(b.data.length);
    }
    return null;
  }

  extractTotal(response: RawResponse): number | null {
    if (typeof response.body === "object" && response.body !== null) {
      const b = response.body as Record<string, unknown>;
      if (typeof b.total_count === "number") return b.total_count;
    }
    return null;
  }

  hasNext(response: RawResponse): boolean {
    return this.extractCursor(response) !== null;
  }

  buildNextRequest(
    endpoint: string,
    options: RequestOptions,
    cursor: string,
  ): { endpoint: string; options: RequestOptions } {
    const query = { ...options.query };
    const skip = Number.parseInt(String(query.skip ?? 0), 10);
    const limit = Number.parseInt(cursor, 10);
    query.skip = skip + limit;
    return { endpoint, options: { ...options, query } };
  }
}
