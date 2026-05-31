import type { PaginationStrategy, RawResponse, RequestOptions } from "../../core/types.js";

export class GupshupPaginationStrategy implements PaginationStrategy {
  private readonly defaultLimit = 20;

  extractCursor(response: RawResponse): string | null {
    if (typeof response.body === "object" && response.body !== null) {
      const body = response.body as Record<string, unknown>;
      const items = Array.isArray(body["messages"])
        ? (body["messages"] as unknown[])
        : Array.isArray(body["response"])
        ? (body["response"] as unknown[])
        : null;
      if (items !== null) {
        const currentOffset = 0; // accumulated by buildNextRequest
        return items.length > 0 ? String(currentOffset + items.length) : null;
      }
    }
    return null;
  }

  extractTotal(response: RawResponse): number | null {
    if (typeof response.body === "object" && response.body !== null) {
      const body = response.body as Record<string, unknown>;
      if (typeof body["total"] === "number") return body["total"];
    }
    return null;
  }

  hasNext(response: RawResponse): boolean {
    if (typeof response.body === "object" && response.body !== null) {
      const body = response.body as Record<string, unknown>;
      const items = Array.isArray(body["messages"])
        ? (body["messages"] as unknown[])
        : Array.isArray(body["response"])
        ? (body["response"] as unknown[])
        : null;
      if (items !== null) {
        return items.length >= this.defaultLimit;
      }
    }
    return false;
  }

  buildNextRequest(
    endpoint: string,
    options: RequestOptions,
    cursor: string
  ): { endpoint: string; options: RequestOptions } {
    const currentOffset = parseInt(String(options.query?.["offset"] ?? 0), 10);
    const itemsReturned = parseInt(cursor, 10) - currentOffset;
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
