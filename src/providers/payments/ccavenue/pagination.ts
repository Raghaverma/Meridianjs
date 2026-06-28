import type { PaginationStrategy, RawResponse, RequestOptions } from "../../core/types.js";

/**
 * CCAvenue's transaction/order-status APIs are command-driven, single-record
 * lookups rather than paginated listings — there is no documented cursor or
 * page convention. This strategy reports "no further pages" for every response.
 */
export class CcavenuePaginationStrategy implements PaginationStrategy {
  extractCursor(_response: RawResponse): string | null {
    return null;
  }

  extractTotal(_response: RawResponse): number | null {
    return null;
  }

  hasNext(_response: RawResponse): boolean {
    return false;
  }

  buildNextRequest(
    endpoint: string,
    options: RequestOptions,
    _cursor: string,
  ): { endpoint: string; options: RequestOptions } {
    return { endpoint, options };
  }
}
