import type { PaginationStrategy, RawResponse, RequestOptions } from "../core/types.js";

export class CursorPaginationStrategy implements PaginationStrategy {
  private cursorHeader: string;
  private cursorQueryParam: string;
  private totalHeader?: string;

  constructor(cursorHeader = "X-Cursor", cursorQueryParam = "cursor", totalHeader?: string) {
    this.cursorHeader = cursorHeader;
    this.cursorQueryParam = cursorQueryParam;
    if (totalHeader !== undefined) {
      this.totalHeader = totalHeader;
    }
  }

  extractCursor(response: RawResponse): string | null {
    const cursor = response.headers.get(this.cursorHeader);
    if (cursor) {
      return cursor;
    }

    if (typeof response.body === "object" && response.body !== null && "cursor" in response.body) {
      const body = response.body as { cursor?: string };
      const bodyCursor = body.cursor;
      return bodyCursor ?? null;
    }

    return null;
  }

  extractTotal(response: RawResponse): number | null {
    if (this.totalHeader) {
      const total = response.headers.get(this.totalHeader);
      if (total) {
        // A malformed header yields NaN, which is `!== null` but compares
        // false against every number — extractCursor's `>= total` check
        // would then never be true, so a garbage header would never signal
        // end-of-results and pagination would run to the hard page cap
        // instead of stopping cleanly. Treat it as "no total" instead.
        const parsed = Number.parseInt(total, 10);
        if (!Number.isNaN(parsed)) {
          return parsed;
        }
      }
    }

    if (typeof response.body === "object" && response.body !== null && "total" in response.body) {
      const body = response.body as { total?: number };
      return body.total ?? null;
    }

    return null;
  }

  hasNext(response: RawResponse): boolean {
    const cursor = this.extractCursor(response);
    return cursor !== null && cursor !== "";
  }

  buildNextRequest(
    endpoint: string,
    options: RequestOptions,
    cursor: string,
  ): { endpoint: string; options: RequestOptions } {
    const url = new URL(endpoint, "http://dummy");
    url.searchParams.set(this.cursorQueryParam, cursor);

    return {
      endpoint: url.pathname + url.search,
      options: {
        ...options,
        query: {
          ...options.query,
          [this.cursorQueryParam]: cursor,
        },
      },
    };
  }
}

export class OffsetPaginationStrategy implements PaginationStrategy {
  private offsetQueryParam: string;
  private limitQueryParam: string;
  private totalHeader?: string;
  private defaultLimit: number;
  /**
   * Tracks the offset that was sent in the most recent request so that
   * `extractCursor` can compute the *next* offset even when the provider does
   * not echo the current offset in the response body.
   *
   * Without this, `currentOffset` defaults to 0 every time — the computed
   * cursor is always `String(0 + limit)`, and the paginate loop's cycle-
   * detector fires on the second page.
   *
   * Updated inside `buildNextRequest` (which knows the offset for the request
   * it is about to build) so that the following `extractCursor` call sees the
   * correct base.
   */
  private currentOffset = 0;

  constructor(
    offsetQueryParam = "offset",
    limitQueryParam = "limit",
    totalHeader?: string,
    defaultLimit = 100,
  ) {
    this.offsetQueryParam = offsetQueryParam;
    this.limitQueryParam = limitQueryParam;
    if (totalHeader !== undefined) {
      this.totalHeader = totalHeader;
    }
    this.defaultLimit = defaultLimit;
  }

  extractCursor(response: RawResponse): string | null {
    // Prefer the offset the provider echoes back; fall back to what we tracked
    // locally so providers that don't echo still page correctly.
    const currentOffset =
      typeof response.body === "object" && response.body !== null && "offset" in response.body
        ? ((response.body as { offset?: number }).offset ?? this.currentOffset)
        : this.currentOffset;

    const limit =
      typeof response.body === "object" && response.body !== null && "limit" in response.body
        ? ((response.body as { limit?: number }).limit ?? this.defaultLimit)
        : this.defaultLimit;

    const total = this.extractTotal(response);
    if (total !== null) {
      // Authoritative end-of-results signal.
      return currentOffset + limit >= total ? null : String(currentOffset + limit);
    }

    // No total to bound against. Without this guard `hasNext` stays true forever
    // (the offset just keeps climbing), so an empty trailing page would drive the
    // paginator to its hard page cap instead of terminating. Treat an empty page
    // as the end — there is, by definition, nothing after it.
    if (this.pageIsEmpty(response.body)) {
      return null;
    }

    return String(currentOffset + limit);
  }

  /**
   * Best-effort detection of an empty page when the provider gives no `total`.
   * Looks for the result array at the body root or under the common list keys.
   * Returns false when no array can be located (unknown shape — keep paginating
   * so we never under-fetch a provider we don't recognize).
   */
  private pageIsEmpty(body: unknown): boolean {
    if (Array.isArray(body)) {
      return body.length === 0;
    }
    if (typeof body === "object" && body !== null) {
      for (const key of ["items", "data", "results", "records"]) {
        const value = (body as Record<string, unknown>)[key];
        if (Array.isArray(value)) {
          return value.length === 0;
        }
      }
    }
    return false;
  }

  extractTotal(response: RawResponse): number | null {
    if (this.totalHeader) {
      const total = response.headers.get(this.totalHeader);
      if (total) {
        // A malformed header yields NaN, which is `!== null` but compares
        // false against every number — extractCursor's `>= total` check
        // would then never be true, so a garbage header would never signal
        // end-of-results and pagination would run to the hard page cap
        // instead of stopping cleanly. Treat it as "no total" instead.
        const parsed = Number.parseInt(total, 10);
        if (!Number.isNaN(parsed)) {
          return parsed;
        }
      }
    }

    if (typeof response.body === "object" && response.body !== null && "total" in response.body) {
      const body = response.body as { total?: number };
      return body.total ?? null;
    }

    return null;
  }

  hasNext(response: RawResponse): boolean {
    const cursor = this.extractCursor(response);
    return cursor !== null;
  }

  buildNextRequest(
    endpoint: string,
    options: RequestOptions,
    cursor: string,
  ): { endpoint: string; options: RequestOptions } {
    const offset = Number.parseInt(cursor, 10);
    const limitValue = options.query?.[this.limitQueryParam];
    const limit =
      typeof limitValue === "number"
        ? limitValue
        : typeof limitValue === "string"
          ? Number.parseInt(limitValue, 10)
          : this.defaultLimit;

    // Record the offset being sent so that the next extractCursor() call can
    // compute the following offset even if the provider doesn't echo it back.
    this.currentOffset = offset;

    return {
      endpoint,
      options: {
        ...options,
        query: {
          ...options.query,
          [this.offsetQueryParam]: String(offset),
          [this.limitQueryParam]: String(limit),
        },
      },
    };
  }
}
