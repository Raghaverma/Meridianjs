import type { PaginationStrategy, RawResponse, RequestOptions } from "../../../core/types.js";

export class Msg91PaginationStrategy implements PaginationStrategy {
  extractCursor(response: RawResponse): string | null {
    // MSG91 page-based pagination: { data: [...], total: number, current: number }
    // Cursor = next page number as string
    if (typeof response.body === "object" && response.body !== null) {
      const body = response.body as Record<string, unknown>;
      if (Array.isArray(body.data) && typeof body.current === "number") {
        return String((body.current as number) + 1);
      }
    }
    return null;
  }

  extractTotal(response: RawResponse): number | null {
    if (typeof response.body === "object" && response.body !== null) {
      const body = response.body as Record<string, unknown>;
      if (typeof body.total === "number") {
        return body.total as number;
      }
    }
    return null;
  }

  hasNext(response: RawResponse): boolean {
    if (typeof response.body === "object" && response.body !== null) {
      const body = response.body as Record<string, unknown>;
      if (
        Array.isArray(body.data) &&
        typeof body.total === "number" &&
        typeof body.current === "number"
      ) {
        return (body.data as unknown[]).length > 0;
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
          p: cursor,
        },
      },
    };
  }
}
