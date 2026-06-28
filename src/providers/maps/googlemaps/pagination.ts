import type { PaginationStrategy, RawResponse, RequestOptions } from "../../../core/types.js";

/**
 * Google Maps Places API uses `next_page_token` in the JSON response body.
 * The token is passed back as the `pagetoken` query parameter on the next request.
 * Note: Google requires a short delay before using a page token — the token itself
 * becomes valid ~2 seconds after the previous response is received.
 */
export class GoogleMapsPaginationStrategy implements PaginationStrategy {
  extractCursor(response: RawResponse): string | null {
    if (typeof response.body === "object" && response.body !== null) {
      const body = response.body as Record<string, unknown>;
      if (typeof body.next_page_token === "string" && body.next_page_token.length > 0) {
        return body.next_page_token;
      }
    }
    return null;
  }

  extractTotal(_response: RawResponse): number | null {
    return null;
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
          pagetoken: cursor,
        },
      },
    };
  }
}
