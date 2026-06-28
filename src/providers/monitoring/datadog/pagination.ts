import type { PaginationStrategy, RawResponse, RequestOptions } from "../../../core/types.js";

/**
 * Datadog's v2 search APIs (Logs, Events, Spans, ...) return a cursor for the
 * next page at `meta.page.after`, which callers feed back as `page[cursor]`.
 */
export class DatadogPaginationStrategy implements PaginationStrategy {
  extractCursor(response: RawResponse): string | null {
    const cursor = this.readAfterCursor(response);
    return cursor ?? null;
  }

  extractTotal(_response: RawResponse): number | null {
    // Datadog search APIs do not return a total result count.
    return null;
  }

  hasNext(response: RawResponse): boolean {
    return this.readAfterCursor(response) !== null;
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
          "page[cursor]": cursor,
        },
      },
    };
  }

  private readAfterCursor(response: RawResponse): string | null {
    if (typeof response.body !== "object" || response.body === null) return null;
    const body = response.body as Record<string, unknown>;
    const meta = body.meta as Record<string, unknown> | undefined;
    const page = meta?.page as Record<string, unknown> | undefined;
    if (page && typeof page.after === "string" && page.after.length > 0) {
      return page.after;
    }
    return null;
  }
}
