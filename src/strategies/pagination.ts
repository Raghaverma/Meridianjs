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
        return Number.parseInt(total, 10);
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
    const currentOffset =
      typeof response.body === "object" && response.body !== null && "offset" in response.body
        ? ((response.body as { offset?: number }).offset ?? 0)
        : 0;

    const limit =
      typeof response.body === "object" && response.body !== null && "limit" in response.body
        ? ((response.body as { limit?: number }).limit ?? this.defaultLimit)
        : this.defaultLimit;

    const total = this.extractTotal(response);
    if (total !== null && currentOffset + limit >= total) {
      return null;
    }

    return String(currentOffset + limit);
  }

  extractTotal(response: RawResponse): number | null {
    if (this.totalHeader) {
      const total = response.headers.get(this.totalHeader);
      if (total) {
        return Number.parseInt(total, 10);
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
