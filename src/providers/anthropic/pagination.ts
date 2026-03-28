
import type { PaginationStrategy, RawResponse, RequestOptions } from "../../core/types.js";


export class AnthropicPaginationStrategy implements PaginationStrategy {
  extractCursor(response: RawResponse): string | null {
    // Anthropic list APIs (batches, models, etc.) return:
    // { has_more: boolean, last_id: string | null, data: [] }
    if (typeof response.body === "object" && response.body !== null) {
      const body = response.body as Record<string, unknown>;
      if (body["has_more"] === true && typeof body["last_id"] === "string") {
        return body["last_id"];
      }
    }
    return null;
  }

  extractTotal(_response: RawResponse): number | null {
    return null;
  }

  hasNext(response: RawResponse): boolean {
    if (typeof response.body === "object" && response.body !== null) {
      const body = response.body as Record<string, unknown>;
      return body["has_more"] === true;
    }
    return false;
  }

  buildNextRequest(
    endpoint: string,
    options: RequestOptions,
    cursor: string
  ): { endpoint: string; options: RequestOptions } {
    return {
      endpoint,
      options: {
        ...options,
        query: {
          ...options.query,
          after_id: cursor,
        },
      },
    };
  }
}
