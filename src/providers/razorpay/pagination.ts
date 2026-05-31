import type { PaginationStrategy, RawResponse, RequestOptions } from "../../core/types.js";

export class RazorpayPaginationStrategy implements PaginationStrategy {
  extractCursor(response: RawResponse): string | null {
    // Razorpay list responses: { entity: "collection", count: N, items: [...] }
    // Cursor encodes the number of items returned this page; buildNextRequest accumulates skip.
    if (typeof response.body === "object" && response.body !== null) {
      const body = response.body as Record<string, unknown>;
      if (Array.isArray(body["items"])) {
        const items = body["items"] as unknown[];
        return items.length > 0 ? String(items.length) : null;
      }
    }
    return null;
  }

  extractTotal(_response: RawResponse): number | null {
    return null;
  }

  hasNext(response: RawResponse): boolean {
    if (typeof response.body === "object" && response.body !== null) {
      const body = response.body as Record<string, unknown>;
      return Array.isArray(body["items"]) && (body["items"] as unknown[]).length > 0;
    }
    return false;
  }

  buildNextRequest(
    endpoint: string,
    options: RequestOptions,
    cursor: string,
  ): { endpoint: string; options: RequestOptions } {
    const currentSkip = Number.parseInt(String(options.query?.["skip"] ?? 0), 10);
    const itemsReturned = Number.parseInt(cursor, 10);
    return {
      endpoint,
      options: {
        ...options,
        query: {
          ...options.query,
          skip: currentSkip + itemsReturned,
        },
      },
    };
  }
}
