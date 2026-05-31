import type { PaginationStrategy, RawResponse, RequestOptions } from "../../core/types.js";

interface DigioListBody {
  entity_list: unknown[];
  response_code: number;
  total_count: number;
}

export class DigioPaginationStrategy implements PaginationStrategy {
  extractCursor(response: RawResponse): string | null {
    if (typeof response.body === "object" && response.body !== null) {
      const body = response.body as Record<string, unknown>;
      const pageNo = body.page_no;
      if (typeof pageNo === "number") {
        return String(pageNo + 1);
      }
    }
    return null;
  }

  extractTotal(response: RawResponse): number | null {
    if (typeof response.body === "object" && response.body !== null) {
      const body = response.body as Partial<DigioListBody>;
      if (typeof body.total_count === "number") {
        return body.total_count;
      }
    }
    return null;
  }

  hasNext(response: RawResponse): boolean {
    if (typeof response.body === "object" && response.body !== null) {
      const body = response.body as Partial<DigioListBody> & Record<string, unknown>;
      const items = body.entity_list;
      if (!Array.isArray(items) || items.length === 0) return false;

      const total = typeof body.total_count === "number" ? body.total_count : null;
      if (total === null) return false;

      const offset = typeof body.offset === "number" ? (body.offset as number) : 0;
      return offset + items.length < total;
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
