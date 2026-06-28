import type { PaginationStrategy, RawResponse, RequestOptions } from "../../../core/types.js";

export class TwilioPaginationStrategy implements PaginationStrategy {
  extractCursor(response: RawResponse): string | null {
    const body = response.body as Record<string, unknown> | null | undefined;
    if (!body || typeof body !== "object") {
      return null;
    }

    // Twilio list responses carry next_page_uri (relative) at the top level
    // and also meta.next_page_url (absolute) inside the meta object.
    // Prefer next_page_uri; fall back to meta.next_page_url.
    const nextPageUri = body.next_page_uri;
    if (typeof nextPageUri === "string" && nextPageUri.length > 0) {
      return nextPageUri;
    }

    const meta = body.meta;
    if (meta && typeof meta === "object") {
      const nextPageUrl = (meta as Record<string, unknown>).next_page_url;
      if (typeof nextPageUrl === "string" && nextPageUrl.length > 0) {
        return nextPageUrl;
      }
    }

    return null;
  }

  extractTotal(response: RawResponse): number | null {
    const body = response.body as Record<string, unknown> | null | undefined;
    if (!body || typeof body !== "object") {
      return null;
    }

    const meta = body.meta;
    if (meta && typeof meta === "object") {
      const total = (meta as Record<string, unknown>).total;
      if (typeof total === "number" && !Number.isNaN(total)) {
        return total;
      }
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
    // cursor is the next_page_uri value. If it is absolute, strip the origin.
    let nextEndpoint = cursor;
    try {
      const url = new URL(cursor);
      // Strip scheme + host so the adapter baseUrl is used instead
      nextEndpoint = url.pathname + url.search;
    } catch {
      // Already a relative URI — use as-is
    }

    return {
      endpoint: nextEndpoint,
      options: { ...options },
    };
  }
}
