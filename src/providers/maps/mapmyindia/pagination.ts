import type { PaginationStrategy, RawResponse, RequestOptions } from "../../core/types.js";

export class MapmyindiaPaginationStrategy implements PaginationStrategy {
  extractCursor(response: RawResponse): string | null {
    // MapmyIndia offset-based pagination
    // Response: { suggestedLocations: [...], userAddedLocations: [...], totalItems?: number }
    // OR:       { results: [...] }
    if (typeof response.body === "object" && response.body !== null) {
      const body = response.body as Record<string, unknown>;
      const suggestedLocations = body.suggestedLocations;
      const results = body.results;

      const items = Array.isArray(suggestedLocations)
        ? suggestedLocations
        : Array.isArray(results)
          ? results
          : null;

      if (items !== null && items.length > 0) {
        const totalItems = typeof body.totalItems === "number" ? body.totalItems : null;
        // Need an offset to build next cursor; use query offset from context via cursor accumulation.
        // The cursor passed into buildNextRequest IS the current offset already accumulated.
        // Here we just return the item count as the delta — buildNextRequest adds to the prior offset.
        if (totalItems === null || items.length > 0) {
          return String(items.length);
        }
      }
    }
    return null;
  }

  extractTotal(response: RawResponse): number | null {
    if (typeof response.body === "object" && response.body !== null) {
      const body = response.body as Record<string, unknown>;
      if (typeof body.totalItems === "number") {
        return body.totalItems;
      }
    }
    return null;
  }

  hasNext(response: RawResponse): boolean {
    if (typeof response.body === "object" && response.body !== null) {
      const body = response.body as Record<string, unknown>;
      const suggestedLocations = body.suggestedLocations;
      const results = body.results;

      const items = Array.isArray(suggestedLocations)
        ? suggestedLocations
        : Array.isArray(results)
          ? results
          : null;

      if (items === null || items.length === 0) {
        return false;
      }

      const totalItems = typeof body.totalItems === "number" ? body.totalItems : null;
      if (totalItems !== null) {
        // We don't have the current offset here directly; rely on extractCursor returning non-null
        // as the signal. hasNext is true when items were returned and total not yet exhausted.
        // Since we don't carry offset here, we conservatively return true when items.length > 0
        // and we know there are more (totalItems not reached). The pipeline uses extractCursor
        // returning null as the definitive stop signal.
        return items.length > 0;
      }

      return items.length > 0;
    }
    return false;
  }

  buildNextRequest(
    endpoint: string,
    options: RequestOptions,
    cursor: string,
  ): { endpoint: string; options: RequestOptions } {
    const currentOffset = Number.parseInt(String(options.query?.offset ?? 0), 10);
    const itemsReturned = Number.parseInt(cursor, 10);
    return {
      endpoint,
      options: {
        ...options,
        query: {
          ...options.query,
          itemCount: 10,
          offset: String(currentOffset + itemsReturned),
        },
      },
    };
  }
}
