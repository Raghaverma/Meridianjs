import type { PaginationStrategy, RawResponse, RequestOptions } from "../../core/types.js";

export class AdyenPaginationStrategy implements PaginationStrategy {
  extractCursor(response: RawResponse): string | null {
    if (Array.isArray(response.body)) {
      return response.body.length > 0 ? String(response.body.length) : null;
    }
    if (typeof response.body === "object" && response.body !== null) {
      const body = response.body as Record<string, unknown>;
      for (const val of Object.values(body)) {
        if (Array.isArray(val)) {
          return val.length > 0 ? String(val.length) : null;
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
    const itemsReturned = Number.parseInt(cursor, 10);
    const query = { ...options.query };

    if (query.offset !== undefined) {
      const currentOffset = Number.parseInt(String(query.offset), 10);
      query.offset = currentOffset + itemsReturned;
    } else if (query.pageNumber !== undefined) {
      const currentPageNumber = Number.parseInt(String(query.pageNumber), 10);
      query.pageNumber = currentPageNumber + 1;
    } else if (query.page !== undefined) {
      const currentPage = Number.parseInt(String(query.page), 10);
      query.page = currentPage + 1;
    } else {
      const currentOffset = Number.parseInt(String(query.offset ?? 0), 10);
      query.offset = currentOffset + itemsReturned;
    }

    return {
      endpoint,
      options: {
        ...options,
        query,
      },
    };
  }
}
