import type { PaginationStrategy, RawResponse, RequestOptions } from "../../core/types.js";

const DEFAULT_PAGE_SIZE = 20;

/**
 * BillDesk list endpoints (e.g. transaction search) are page-based:
 * { transactions: [...], page_number: number, total_pages: number }
 */
export class BilldeskPaginationStrategy implements PaginationStrategy {
  extractCursor(response: RawResponse): string | null {
    if (typeof response.body === "object" && response.body !== null) {
      const body = response.body as Record<string, unknown>;
      if (typeof body.page_number === "number") {
        return String(body.page_number + 1);
      }
    }
    return null;
  }

  extractTotal(response: RawResponse): number | null {
    if (typeof response.body === "object" && response.body !== null) {
      const body = response.body as Record<string, unknown>;
      if (typeof body.total_count === "number") {
        return body.total_count;
      }
    }
    return null;
  }

  hasNext(response: RawResponse): boolean {
    if (typeof response.body === "object" && response.body !== null) {
      const body = response.body as Record<string, unknown>;
      if (typeof body.page_number === "number" && typeof body.total_pages === "number") {
        return body.page_number < body.total_pages;
      }
      const items = body.transactions ?? body.data;
      if (Array.isArray(items)) {
        return items.length === DEFAULT_PAGE_SIZE;
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
          page_number: cursor,
        },
      },
    };
  }
}
