import type { PaginationStrategy, RawResponse, RequestOptions } from "../../../core/types.js";

/**
 * Extracts a top-level XML element's text content via a narrow regex match.
 * S3's ListObjectsV2 response is flat enough (no nested elements share these
 * tag names) that a full XML parser isn't warranted here.
 */
function extractXmlField(xml: string, tag: string): string | null {
  const match = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  return match?.[1] ?? null;
}

/**
 * S3 / R2's `ListObjectsV2` returns XML with `IsTruncated` and, when there are
 * more results, a `NextContinuationToken` — fed back as the `continuation-token`
 * query parameter. The SDK's HTTP layer hands us the raw XML string as the body
 * for non-JSON responses.
 */
export class S3PaginationStrategy implements PaginationStrategy {
  extractCursor(response: RawResponse): string | null {
    const xml = this.bodyAsXml(response);
    if (!xml) return null;
    return extractXmlField(xml, "NextContinuationToken");
  }

  extractTotal(response: RawResponse): number | null {
    const xml = this.bodyAsXml(response);
    if (!xml) return null;
    const keyCount = extractXmlField(xml, "KeyCount");
    if (keyCount === null) return null;
    const parsed = Number.parseInt(keyCount, 10);
    return Number.isNaN(parsed) ? null : parsed;
  }

  hasNext(response: RawResponse): boolean {
    const xml = this.bodyAsXml(response);
    if (!xml) return false;
    return extractXmlField(xml, "IsTruncated") === "true";
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
          "continuation-token": cursor,
        },
      },
    };
  }

  private bodyAsXml(response: RawResponse): string | null {
    if (typeof response.body === "string" && response.body.includes("<ListBucketResult")) {
      return response.body;
    }
    return null;
  }
}
