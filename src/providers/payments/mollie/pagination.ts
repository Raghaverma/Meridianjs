import type { PaginationStrategy, RawResponse, RequestOptions } from "../../core/types.js";

export class MolliePaginationStrategy implements PaginationStrategy {
  extractCursor(response: RawResponse): string | null {
    if (typeof response.body === "object" && response.body !== null) {
      const b = response.body as Record<string, unknown>;
      const links = b._links as Record<string, unknown> | undefined;
      if (links?.next && typeof links.next === "object") {
        const next = links.next as Record<string, unknown>;
        if (typeof next.href === "string") return next.href;
      }
    }
    return null;
  }

  extractTotal(response: RawResponse): number | null {
    if (typeof response.body === "object" && response.body !== null) {
      const b = response.body as Record<string, unknown>;
      if (typeof b.count === "number") return b.count;
    }
    return null;
  }

  hasNext(response: RawResponse): boolean {
    return this.extractCursor(response) !== null;
  }

  buildNextRequest(
    _endpoint: string,
    options: RequestOptions,
    cursor: string,
  ): { endpoint: string; options: RequestOptions } {
    // cursor is the full next href URL — extract relative path
    try {
      const url = new URL(cursor);
      return { endpoint: `${url.pathname}${url.search}`, options };
    } catch {
      return { endpoint: cursor, options };
    }
  }
}
