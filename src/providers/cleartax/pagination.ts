import type { PaginationStrategy, RawResponse, RequestOptions } from "../../core/types.js";

export class CleartaxPaginationStrategy implements PaginationStrategy {
  extractCursor(response: RawResponse): string | null {
    // ClearTax page-based pagination: { data: [...], meta: { total, page, per_page } }
    // OR einvoice list: { einvoices: [...], total_count: number }
    if (typeof response.body === "object" && response.body !== null) {
      const body = response.body as Record<string, unknown>;
      const meta = body["meta"] as Record<string, unknown> | undefined;
      if (meta !== undefined) {
        const page = typeof meta["page"] === "number" ? meta["page"] : null;
        const perPage = typeof meta["per_page"] === "number" ? meta["per_page"] : null;
        const total = typeof meta["total"] === "number" ? meta["total"] : null;
        if (page !== null && perPage !== null && total !== null) {
          if (page * perPage < total) {
            return String(page + 1);
          }
        }
      }
    }
    return null;
  }

  extractTotal(response: RawResponse): number | null {
    if (typeof response.body === "object" && response.body !== null) {
      const body = response.body as Record<string, unknown>;
      const meta = body["meta"] as Record<string, unknown> | undefined;
      if (meta !== undefined && typeof meta["total"] === "number") {
        return meta["total"];
      }
      if (typeof body["total_count"] === "number") {
        return body["total_count"];
      }
    }
    return null;
  }

  hasNext(response: RawResponse): boolean {
    if (typeof response.body === "object" && response.body !== null) {
      const body = response.body as Record<string, unknown>;
      const meta = body["meta"] as Record<string, unknown> | undefined;
      if (meta !== undefined) {
        const page = typeof meta["page"] === "number" ? meta["page"] : null;
        const perPage = typeof meta["per_page"] === "number" ? meta["per_page"] : null;
        const total = typeof meta["total"] === "number" ? meta["total"] : null;
        if (page !== null && perPage !== null && total !== null) {
          return page * perPage < total;
        }
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
          page_no: cursor,
        },
      },
    };
  }
}
