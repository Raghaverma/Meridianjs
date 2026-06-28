import type { PaginationStrategy, RawResponse, RequestOptions } from "../../../core/types.js";

export class BraintreePaginationStrategy implements PaginationStrategy {
  extractCursor(response: RawResponse): string | null {
    if (typeof response.body === "object" && response.body !== null) {
      const body = response.body as Record<string, unknown>;
      // Braintree search results return page details or arrays
      for (const val of Object.values(body)) {
        if (Array.isArray(val)) {
          return val.length > 0 ? String(val.length) : null;
        }
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
    cursor: string,
  ): { endpoint: string; options: RequestOptions } {
    const itemsReturned = Number.parseInt(cursor, 10);
    const query = { ...options.query };
    const currentOffset = Number.parseInt(String(query.offset ?? 0), 10);
    query.offset = currentOffset + itemsReturned;

    return {
      endpoint,
      options: {
        ...options,
        query,
      },
    };
  }
}
