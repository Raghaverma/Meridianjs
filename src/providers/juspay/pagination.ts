
import type { PaginationStrategy, RawResponse, RequestOptions } from "../../core/types.js";


export class JuspayPaginationStrategy implements PaginationStrategy {
  extractCursor(response: RawResponse): string | null {
    // Juspay offset-based pagination: { list: [...], total: number }
    // Cursor = next offset as string
    if (typeof response.body === "object" && response.body !== null) {
      const body = response.body as Record<string, unknown>;
      if (Array.isArray(body["list"]) && (body["list"] as unknown[]).length > 0) {
        const currentOffset = 0; // Will be computed accurately in buildNextRequest
        return String(currentOffset + (body["list"] as unknown[]).length);
      }
    }
    return null;
  }

  extractTotal(response: RawResponse): number | null {
    if (typeof response.body === "object" && response.body !== null) {
      const body = response.body as Record<string, unknown>;
      if (typeof body["total"] === "number") {
        return body["total"] as number;
      }
    }
    return null;
  }

  hasNext(response: RawResponse): boolean {
    if (typeof response.body === "object" && response.body !== null) {
      const body = response.body as Record<string, unknown>;
      if (Array.isArray(body["list"]) && typeof body["total"] === "number") {
        return (body["list"] as unknown[]).length > 0;
      }
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
          offset: cursor,
        },
      },
    };
  }
}
