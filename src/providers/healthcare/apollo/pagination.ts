import type { PaginationStrategy, RawResponse, RequestOptions } from "../../../core/types.js";

export class ApolloPaginationStrategy implements PaginationStrategy {
  extractCursor(response: RawResponse): string | null {
    if (typeof response.body === "object" && response.body !== null) {
      const b = response.body as Record<string, unknown>;
      if (b.pagination && typeof b.pagination === "object") {
        const pag = b.pagination as Record<string, unknown>;
        const page = Number(pag.page ?? 1);
        const totalPages = Number(pag.total_pages ?? 1);
        if (!Number.isNaN(page) && !Number.isNaN(totalPages) && page < totalPages) {
          return String(page + 1);
        }
      }
    }
    return null;
  }

  extractTotal(response: RawResponse): number | null {
    if (typeof response.body === "object" && response.body !== null) {
      const b = response.body as Record<string, unknown>;
      if (b.pagination && typeof b.pagination === "object") {
        const pag = b.pagination as Record<string, unknown>;
        if (typeof pag.total_entries === "number") {
          return pag.total_entries;
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
