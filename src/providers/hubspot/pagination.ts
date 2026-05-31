import type { PaginationStrategy, RawResponse, RequestOptions } from "../../core/types.js";

export class HubSpotPaginationStrategy implements PaginationStrategy {
  extractCursor(response: RawResponse): string | null {
    if (typeof response.body === "object" && response.body !== null) {
      const body = response.body as Record<string, unknown>;
      const paging = body.paging as Record<string, unknown> | undefined;
      const next = paging?.next as Record<string, unknown> | undefined;
      if (next && typeof next.after === "string" && next.after.length > 0) {
        return next.after;
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
    return {
      endpoint,
      options: {
        ...options,
        query: {
          ...options.query,
          after: cursor,
        },
      },
    };
  }
}
