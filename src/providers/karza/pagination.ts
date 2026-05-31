
import type { PaginationStrategy, RawResponse, RequestOptions } from "../../core/types.js";


export class KarzaPaginationStrategy implements PaginationStrategy {
  // Karza is a stateless verification API — no cursor-based pagination
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
    _cursor: string
  ): { endpoint: string; options: RequestOptions } {
    return { endpoint, options };
  }
}
