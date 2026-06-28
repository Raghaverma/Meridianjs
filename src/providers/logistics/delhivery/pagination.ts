import type { PaginationStrategy, RawResponse, RequestOptions } from "../../core/types.js";

export class DelhiveryPaginationStrategy implements PaginationStrategy {
  private readonly defaultLimit = 50;

  extractCursor(response: RawResponse): string | null {
    if (typeof response.body === "object" && response.body !== null) {
      const body = response.body as Record<string, unknown>;
      const items = Array.isArray(body.data) ? (body.data as unknown[]) : null;
      if (items !== null && items.length > 0) {
        const currentOffset = 0; // accumulated by buildNextRequest
        return String(currentOffset + items.length);
      }
    }
    return null;
  }

  extractTotal(response: RawResponse): number | null {
    if (typeof response.body === "object" && response.body !== null) {
      const body = response.body as Record<string, unknown>;
      if (typeof body.count === "number") return body.count;
    }
    return null;
  }

  hasNext(response: RawResponse): boolean {
    if (typeof response.body === "object" && response.body !== null) {
      const body = response.body as Record<string, unknown>;
      const items = Array.isArray(body.data) ? (body.data as unknown[]) : null;
      if (items !== null) {
        return items.length > 0 && items.length === this.defaultLimit;
      }
    }
    return false;
  }

  buildNextRequest(
    endpoint: string,
    options: RequestOptions,
    cursor: string,
  ): { endpoint: string; options: RequestOptions } {
    const currentOffset = Number.parseInt(String(options.query?.offset ?? 0), 10);
    const itemsReturned = Number.parseInt(cursor, 10) - currentOffset;
    return {
      endpoint,
      options: {
        ...options,
        query: {
          ...options.query,
          offset: currentOffset + itemsReturned,
        },
      },
    };
  }
}
