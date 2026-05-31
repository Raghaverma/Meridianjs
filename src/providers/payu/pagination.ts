import type { PaginationStrategy, RawResponse, RequestOptions } from "../../core/types.js";

const DEFAULT_PAGE_SIZE = 20;

export class PayuPaginationStrategy implements PaginationStrategy {
  extractCursor(response: RawResponse): string | null {
    // PayU page-based pagination: { data: [...], total: number }
    // Cursor = next page number as string
    if (typeof response.body === "object" && response.body !== null) {
      const body = response.body as Record<string, unknown>;
      if (Array.isArray(body.data) && (body.data as unknown[]).length === DEFAULT_PAGE_SIZE) {
        // Infer current page from the existing query or default to page 1
        return null; // Computed in buildNextRequest; extractCursor only signals presence
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
      if (Array.isArray(body.data)) {
        return (body.data as unknown[]).length === DEFAULT_PAGE_SIZE;
      }
    }
    return false;
  }

  buildNextRequest(
    endpoint: string,
    options: RequestOptions,
    _cursor: string,
  ): { endpoint: string; options: RequestOptions } {
    const currentPage = Number.parseInt(String(options.query?.page ?? 1), 10);
    const nextPage = String(currentPage + 1);
    return {
      endpoint,
      options: {
        ...options,
        query: {
          ...options.query,
          page: nextPage,
        },
      },
    };
  }
}
