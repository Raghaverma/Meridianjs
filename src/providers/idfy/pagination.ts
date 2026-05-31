import type { PaginationStrategy, RawResponse, RequestOptions } from "../../core/types.js";

interface IdfyListMeta {
  total: number;
  page: number;
  per_page: number;
}

interface IdfyListBody {
  data: unknown[];
  meta: IdfyListMeta;
}

export class IdfyPaginationStrategy implements PaginationStrategy {
  extractCursor(response: RawResponse): string | null {
    if (typeof response.body === "object" && response.body !== null) {
      const body = response.body as Partial<IdfyListBody>;
      if (typeof body.meta?.page === "number") {
        return String(body.meta.page + 1);
      }
    }
    return null;
  }

  extractTotal(response: RawResponse): number | null {
    if (typeof response.body === "object" && response.body !== null) {
      const body = response.body as Partial<IdfyListBody>;
      if (typeof body.meta?.total === "number") {
        return body.meta.total;
      }
    }
    return null;
  }

  hasNext(response: RawResponse): boolean {
    if (typeof response.body === "object" && response.body !== null) {
      const body = response.body as Partial<IdfyListBody>;
      const meta = body.meta;
      if (
        !meta ||
        typeof meta.page !== "number" ||
        typeof meta.per_page !== "number" ||
        typeof meta.total !== "number"
      ) {
        return false;
      }
      return meta.page * meta.per_page < meta.total;
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
