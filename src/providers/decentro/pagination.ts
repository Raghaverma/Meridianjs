import type { PaginationStrategy, RawResponse, RequestOptions } from "../../core/types.js";

export class DecentroPaginationStrategy implements PaginationStrategy {
  extractCursor(response: RawResponse): string | null {
    if (typeof response.body === "object" && response.body !== null) {
      const body = response.body as Record<string, unknown>;
      const page = typeof body["page"] === "number" ? body["page"] : null;
      if (page !== null) {
        return String(page + 1);
      }
    }
    return null;
  }

  extractTotal(response: RawResponse): number | null {
    if (typeof response.body === "object" && response.body !== null) {
      const body = response.body as Record<string, unknown>;
      if (typeof body["totalCount"] === "number") return body["totalCount"];
    }
    return null;
  }

  hasNext(response: RawResponse): boolean {
    if (typeof response.body === "object" && response.body !== null) {
      const body = response.body as Record<string, unknown>;
      const page = typeof body["page"] === "number" ? body["page"] : null;
      const size = typeof body["size"] === "number" ? body["size"] : null;
      const totalCount = typeof body["totalCount"] === "number" ? body["totalCount"] : null;
      if (page !== null && size !== null && totalCount !== null) {
        return page * size < totalCount;
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
          page: cursor,
        },
      },
    };
  }
}
