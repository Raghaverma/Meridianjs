
import type { PaginationStrategy, RawResponse, RequestOptions } from "../../core/types.js";


export class CashfreePaginationStrategy implements PaginationStrategy {
  extractCursor(response: RawResponse): string | null {
    // Cashfree cursor-based pagination: { data: [...], cursor: string | null }
    if (typeof response.body === "object" && response.body !== null) {
      const body = response.body as Record<string, unknown>;
      const cursor = body["cursor"];
      if (typeof cursor === "string" && cursor.length > 0) {
        return cursor;
      }
    }
    return null;
  }

  extractTotal(_response: RawResponse): number | null {
    return null;
  }

  hasNext(response: RawResponse): boolean {
    return this.extractCursor(response) !== null;
  }

  buildNextRequest(
    endpoint: string,
    options: RequestOptions,
    cursor: string
  ): { endpoint: string; options: RequestOptions } {
    return {
      endpoint,
      options: {
        ...options,
        query: {
          ...options.query,
          cursor,
        },
      },
    };
  }
}
