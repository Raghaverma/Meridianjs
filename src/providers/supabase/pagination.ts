import type { PaginationStrategy, RawResponse, RequestOptions } from "../../core/types.js";

export class SupabasePaginationStrategy implements PaginationStrategy {
  extractCursor(response: RawResponse): string | null {
    const contentRange =
      response.headers.get("Content-Range") ?? response.headers.get("content-range");
    if (contentRange) {
      const match = contentRange.match(/^(\d+)-(\d+)\/(\d+|\*)$/);
      if (match) {
        const start = Number.parseInt(match[1] ?? "", 10);
        const end = Number.parseInt(match[2] ?? "", 10);
        const totalStr = match[3] ?? "";
        const limit = end - start + 1;
        const nextStart = end + 1;

        if (totalStr !== "*") {
          const total = Number.parseInt(totalStr, 10);
          if (nextStart < total) {
            return `${nextStart}:${limit}`;
          }
        } else {
          // If total is *, we might check if the returned count matches the expected limit
          return `${nextStart}:${limit}`;
        }
      }
    }
    return null;
  }

  extractTotal(response: RawResponse): number | null {
    const contentRange =
      response.headers.get("Content-Range") ?? response.headers.get("content-range");
    if (contentRange) {
      const match = contentRange.match(/^(\d+)-(\d+)\/(\d+)$/);
      if (match) {
        return Number.parseInt(match[3] ?? "", 10);
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
    cursor: string,
  ): { endpoint: string; options: RequestOptions } {
    const [nextStart, limit] = cursor.split(":");
    const startNum = Number.parseInt(nextStart ?? "", 10);
    const limitNum = Number.parseInt(limit ?? "", 10);
    const endNum = startNum + limitNum - 1;

    return {
      endpoint,
      options: {
        ...options,
        headers: {
          ...options.headers,
          Range: `${startNum}-${endNum}`,
        },
      },
    };
  }
}
