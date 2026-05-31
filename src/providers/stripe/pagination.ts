import type { PaginationStrategy, RawResponse, RequestOptions } from "../../core/types.js";

export class StripePaginationStrategy implements PaginationStrategy {
  extractCursor(response: RawResponse): string | null {
    // Stripe list responses: { object: "list", data: [...], has_more: boolean, url: string }
    // Cursor for next page = id of the last item in data
    if (typeof response.body === "object" && response.body !== null) {
      const body = response.body as Record<string, unknown>;
      if (body.has_more === true && Array.isArray(body.data)) {
        const data = body.data as unknown[];
        const lastItem = data[data.length - 1];
        if (
          lastItem !== undefined &&
          typeof lastItem === "object" &&
          lastItem !== null &&
          "id" in lastItem &&
          typeof (lastItem as Record<string, unknown>).id === "string"
        ) {
          return (lastItem as Record<string, unknown>).id as string;
        }
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
      return body.has_more === true;
    }
    return false;
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
          starting_after: cursor,
        },
      },
    };
  }
}
