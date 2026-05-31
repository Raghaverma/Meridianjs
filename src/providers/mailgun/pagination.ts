import type { PaginationStrategy, RawResponse, RequestOptions } from "../../core/types.js";

export class MailgunPaginationStrategy implements PaginationStrategy {
  extractCursor(response: RawResponse): string | null {
    if (typeof response.body === "object" && response.body !== null) {
      const body = response.body as Record<string, unknown>;
      const paging = body.paging as Record<string, unknown> | undefined;
      if (paging && typeof paging === "object") {
        const next = paging.next;
        if (typeof next === "string" && next.length > 0) {
          return next;
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
    let nextEndpoint = endpoint;
    const nextQuery: Record<string, string> = {};

    try {
      const url = new URL(cursor);
      nextEndpoint = url.pathname;
      url.searchParams.forEach((val, key) => {
        nextQuery[key] = val;
      });
    } catch {
      nextQuery.page = cursor;
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
