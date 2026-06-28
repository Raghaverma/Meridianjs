import { findLinkByRel, parseLinkHeader } from "../../../core/header-parser.js";
import type { PaginationStrategy, RawResponse, RequestOptions } from "../../../core/types.js";

export class GitHubPaginationStrategy implements PaginationStrategy {
  extractCursor(response: RawResponse): string | null {
    const linkHeader = response.headers.get("Link");
    if (!linkHeader) {
      return null;
    }

    const links = parseLinkHeader(linkHeader);
    const nextLink = findLinkByRel(links, "next");

    if (!nextLink) {
      return null;
    }

    try {
      const url = new URL(nextLink.url);
      const page = url.searchParams.get("page");
      return page;
    } catch {
      return null;
    }
  }

  extractTotal(response: RawResponse): number | null {
    const totalHeader = response.headers.get("X-Total-Count");
    if (totalHeader) {
      const parsed = Number.parseInt(totalHeader, 10);

      if (!Number.isNaN(parsed) && parsed >= 0 && parsed <= Number.MAX_SAFE_INTEGER) {
        return parsed;
      }
    }

    return null;
  }

  hasNext(response: RawResponse): boolean {
    const linkHeader = response.headers.get("Link");
    if (!linkHeader) {
      return false;
    }

    const links = parseLinkHeader(linkHeader);
    return findLinkByRel(links, "next") !== null;
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
