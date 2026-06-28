import type { PaginationStrategy, RawResponse, RequestOptions } from "../../../core/types.js";

export class ExotelPaginationStrategy implements PaginationStrategy {
  extractCursor(response: RawResponse): string | null {
    // Exotel page-based pagination:
    // { data: { Calls/SmsList/etc: [...] }, metadata: { nrecords, page, pagesize } }
    if (typeof response.body === "object" && response.body !== null) {
      const body = response.body as Record<string, unknown>;
      const metadata = body.metadata as Record<string, unknown> | undefined;
      if (metadata && typeof metadata.page === "number") {
        return String((metadata.page as number) + 1);
      }
    }
    return null;
  }

  extractTotal(response: RawResponse): number | null {
    if (typeof response.body === "object" && response.body !== null) {
      const body = response.body as Record<string, unknown>;
      const metadata = body.metadata as Record<string, unknown> | undefined;
      if (metadata && typeof metadata.nrecords === "number") {
        return metadata.nrecords as number;
      }
    }
    return null;
  }

  hasNext(response: RawResponse): boolean {
    if (typeof response.body === "object" && response.body !== null) {
      const body = response.body as Record<string, unknown>;
      const metadata = body.metadata as Record<string, unknown> | undefined;
      const data = body.data as Record<string, unknown> | undefined;

      if (!metadata || !data) return false;

      const pagesize = metadata.pagesize as number | undefined;
      if (!pagesize) return false;

      // Find the list array inside data (Calls, SmsList, etc.)
      const listValues = Object.values(data);
      const list = listValues.find((v) => Array.isArray(v)) as unknown[] | undefined;

      return list !== undefined && list.length === pagesize;
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
          Page: cursor,
        },
      },
    };
  }
}
