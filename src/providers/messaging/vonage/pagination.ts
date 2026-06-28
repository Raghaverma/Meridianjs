import type { PaginationStrategy, RawResponse, RequestOptions } from "../../../core/types.js";

export class VonagePaginationStrategy implements PaginationStrategy {
  extractCursor(response: RawResponse): string | null {
    if (typeof response.body === "object" && response.body !== null) {
      const body = response.body as Record<string, unknown>;
      const links = body._links as Record<string, unknown> | undefined;
      if (links && typeof links === "object") {
        const next = links.next as Record<string, unknown> | undefined;
        if (next && typeof next.href === "string" && next.href.length > 0) {
          return next.href;
        }
      }
    }
    return null;
  }

  extractTotal(response: RawResponse): number | null {
    if (typeof response.body === "object" && response.body !== null) {
      const body = response.body as Record<string, unknown>;
      const count = body.count;
      if (typeof count === "number" && !Number.isNaN(count)) {
        return count;
      }
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
    let nextEndpoint = endpoint;
    const nextQuery: Record<string, string> = {};

    try {
      const url = new URL(cursor);
      nextEndpoint = url.pathname;
      url.searchParams.forEach((val, key) => {
        nextQuery[key] = val;
      });
    } catch {
      try {
        const url = new URL(cursor, "https://api.nexmo.com");
        nextEndpoint = endpoint;
        url.searchParams.forEach((val, key) => {
          nextQuery[key] = val;
        });
      } catch {
        nextQuery.page = cursor;
      }
    }

    return {
      endpoint: nextEndpoint,
      options: {
        ...options,
        query: {
          ...options.query,
          ...nextQuery,
        },
      },
    };
  }
}
