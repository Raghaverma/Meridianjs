import type { PaginationStrategy, RawResponse, RequestOptions } from "../../core/types.js";

interface ShiprocketPagination {
  total: number;
  count: number;
  per_page: number;
  current_page: number;
  total_pages: number;
}

export class ShiprocketPaginationStrategy implements PaginationStrategy {
  private getPagination(response: RawResponse): ShiprocketPagination | null {
    if (typeof response.body === "object" && response.body !== null) {
      const body = response.body as Record<string, unknown>;
      const data = body["data"] as Record<string, unknown> | undefined;
      if (data) {
        const meta = data["meta"] as Record<string, unknown> | undefined;
        if (meta) {
          const pagination = meta["pagination"] as ShiprocketPagination | undefined;
          if (
            pagination &&
            typeof pagination.current_page === "number" &&
            typeof pagination.total_pages === "number"
          ) {
            return pagination;
          }
        }
      }
    }
    return null;
  }

  extractCursor(response: RawResponse): string | null {
    const pagination = this.getPagination(response);
    if (pagination) {
      return String(pagination.current_page + 1);
    }
    return null;
  }

  extractTotal(response: RawResponse): number | null {
    const pagination = this.getPagination(response);
    if (pagination && typeof pagination.total === "number") {
      return pagination.total;
    }
    return null;
  }

  hasNext(response: RawResponse): boolean {
    const pagination = this.getPagination(response);
    if (pagination) {
      return pagination.current_page < pagination.total_pages;
    }
    return false;
  }

  buildNextRequest(
    endpoint: string,
    options: RequestOptions,
    cursor: string
  ): { endpoint: string; options: RequestOptions } {
    return {
      endpoint,
      options: {
        ...options,
        query: {
          ...options.query,
          page: cursor,
        },
      },
    };
  }
}
