import type { PaginationStrategy, RawResponse, RequestOptions } from "../../../core/types.js";

/**
 * Hunter.io uses offset/limit pagination. Paginated endpoints (domain-search,
 * leads, leads_lists) return a `meta` block describing the window:
 *
 *   { "data": { ... }, "meta": { "results": 191, "limit": 10, "offset": 0 } }
 *
 * `results` is the total number of records available; the Leads API nests the
 * same shape under `data.meta` and labels the total `total`. The next page is
 * requested by advancing `offset` by `limit` until the window covers the total.
 */
export class HunterPaginationStrategy implements PaginationStrategy {
  extractCursor(response: RawResponse): string | null {
    const meta = this.getMeta(response);
    if (!meta) return null;

    const limit = Number(meta.limit ?? 0);
    const offset = Number(meta.offset ?? 0);
    const total = Number(meta.results ?? meta.total ?? 0);

    if (
      !Number.isNaN(limit) &&
      !Number.isNaN(offset) &&
      !Number.isNaN(total) &&
      limit > 0 &&
      offset + limit < total
    ) {
      return String(offset + limit);
    }
    return null;
  }

  extractTotal(response: RawResponse): number | null {
    const meta = this.getMeta(response);
    if (!meta) return null;
    const total = meta.results ?? meta.total;
    return typeof total === "number" ? total : null;
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
          offset: cursor,
        },
      },
    };
  }

  private getMeta(response: RawResponse): Record<string, unknown> | null {
    if (typeof response.body === "object" && response.body !== null) {
      const body = response.body as Record<string, unknown>;
      // domain-search / email-count expose `meta` at the top level.
      if (body.meta && typeof body.meta === "object") {
        return body.meta as Record<string, unknown>;
      }
      // The Leads API nests pagination under `data.meta`.
      if (body.data && typeof body.data === "object") {
        const data = body.data as Record<string, unknown>;
        if (data.meta && typeof data.meta === "object") {
          return data.meta as Record<string, unknown>;
        }
      }
    }
    return null;
  }
}
