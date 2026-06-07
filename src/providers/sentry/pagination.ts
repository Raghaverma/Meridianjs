import { findLinkByRel, parseLinkHeader } from "../../core/header-parser.js";
import type { PaginationStrategy, RawResponse, RequestOptions } from "../../core/types.js";

/**
 * Sentry uses RFC 5988 `Link` headers for cursor pagination, e.g.
 *   <https://sentry.io/api/0/...?&cursor=1234:0:0>; rel="next"; results="true"; cursor="1234:0:0"
 * `results="true"` signals more pages are available; the `cursor` link-param
 * (or the `cursor` query string param on the link URL) carries the next cursor.
 */
export class SentryPaginationStrategy implements PaginationStrategy {
  extractCursor(response: RawResponse): string | null {
    const linkHeader = response.headers.get("Link");
    if (!linkHeader) return null;

    const links = parseLinkHeader(linkHeader);
    const nextLink = findLinkByRel(links, "next");
    if (!nextLink) return null;

    if (nextLink.params.cursor) {
      return nextLink.params.cursor;
    }

    try {
      return new URL(nextLink.url).searchParams.get("cursor");
    } catch {
      return null;
    }
  }

  extractTotal(_response: RawResponse): number | null {
    // Sentry's list endpoints don't expose a total-count header.
    return null;
  }

  hasNext(response: RawResponse): boolean {
    const linkHeader = response.headers.get("Link");
    if (!linkHeader) return false;

    const links = parseLinkHeader(linkHeader);
    const nextLink = findLinkByRel(links, "next");
    if (!nextLink) return false;

    return nextLink.params.results !== "false";
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
          cursor,
        },
      },
    };
  }
}
