import type { PaginationStrategy, RawResponse, RequestOptions } from "../../../core/types.js";

export class SendgridPaginationStrategy implements PaginationStrategy {
  extractCursor(response: RawResponse): string | null {
    if (typeof response.body === "object" && response.body !== null) {
      const body = response.body as Record<string, unknown>;
      const metadata = body._metadata as Record<string, unknown> | undefined;
      if (metadata && typeof metadata === "object") {
        const next = metadata.next;
        if (typeof next === "string" && next.length > 0) {
          return next;
        }
      }
      const next = body.next;
      if (typeof next === "string" && next.length > 0) {
        return next;
      }
    }
    return null;
  }

  extractTotal(response: RawResponse): number | null {
    if (typeof response.body === "object" && response.body !== null) {
      const body = response.body as Record<string, unknown>;
      const metadata = body._metadata as Record<string, unknown> | undefined;
      if (metadata && typeof metadata === "object") {
        const count = metadata.count;
        if (typeof count === "number" && !Number.isNaN(count)) {
          return count;
        }
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
        const url = new URL(cursor, "https://api.sendgrid.com");
        nextEndpoint = endpoint;
        url.searchParams.forEach((val, key) => {
          nextQuery[key] = val;
        });
      } catch {
        nextQuery.page_token = cursor;
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
