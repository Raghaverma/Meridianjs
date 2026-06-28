import type { PaginationStrategy, RawResponse, RequestOptions } from "../../../core/types.js";

export class Auth0PaginationStrategy implements PaginationStrategy {
  extractCursor(response: RawResponse): string | null {
    if (Array.isArray(response.body)) {
      return response.body.length > 0 ? String(response.body.length) : null;
    }
    if (typeof response.body === "object" && response.body !== null) {
      const body = response.body as Record<string, unknown>;
      // Look for any array field (e.g., users, logs, clients)
      for (const val of Object.values(body)) {
        if (Array.isArray(val)) {
          return val.length > 0 ? String(val.length) : null;
        }
      }
    }
    return null;
  }

  extractTotal(response: RawResponse): number | null {
    if (typeof response.body === "object" && response.body !== null) {
      const body = response.body as Record<string, unknown>;
      if (typeof body.total === "number") {
        return body.total;
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
    _cursor: string,
  ): { endpoint: string; options: RequestOptions } {
    const query = { ...options.query };
    const currentPage = Number.parseInt(String(query.page ?? 0), 10);
    query.page = currentPage + 1;

    return {
      endpoint,
      options: {
        ...options,
        query,
      },
    };
  }
}
