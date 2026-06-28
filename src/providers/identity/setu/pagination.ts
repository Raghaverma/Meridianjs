import type { PaginationStrategy, RawResponse, RequestOptions } from "../../../core/types.js";

export class SetuPaginationStrategy implements PaginationStrategy {
  extractCursor(response: RawResponse): string | null {
    if (typeof response.body === "object" && response.body !== null) {
      const body = response.body as Record<string, unknown>;
      const data = body.data as Record<string, unknown> | undefined;
      if (data && typeof data.cursor === "string" && data.cursor !== "") {
        return data.cursor;
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
      const data = body.data as Record<string, unknown> | undefined;
      if (data) {
        return typeof data.cursor === "string" && data.cursor !== "";
      }
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
          cursor,
        },
      },
    };
  }
}
