
import type { PaginationStrategy, RawResponse, RequestOptions } from "../../core/types.js";


export class PerfiosPaginationStrategy implements PaginationStrategy {
  // Perfios is a report-retrieval API (bank statement analysis).
  // Responses are discrete reports, not paginated lists.

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
