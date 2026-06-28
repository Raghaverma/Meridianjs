import { createHmac, timingSafeEqual } from "node:crypto";
import type { ProviderAdapter } from "../../core/types.js";

export class WebhookVerifier {
  /**
   * Verify a webhook from any provider adapter that implements verifyWebhook.
   * Throws if the adapter does not support webhook verification.
   */
  static verify(
    adapter: ProviderAdapter,
    payload: string | Buffer,
    signature: string,
    secret: string,
  ): boolean {
    if (typeof adapter.verifyWebhook !== "function") {
      throw new Error(
        `Provider adapter "${adapter.constructor.name}" does not implement verifyWebhook.`,
      );
    }
    return adapter.verifyWebhook(payload, signature, secret);
  }

  /**
   * Timing-safe HMAC-SHA256 comparison helper. Used internally by adapters.
   */
  static hmacSha256(secret: string, payload: string | Buffer): string {
    return createHmac("sha256", secret).update(payload).digest("hex");
  }

  /**
   * Timing-safe HMAC-SHA256 comparison helper for base64-encoded signatures.
   */
  static hmacSha256Base64(secret: string, payload: string | Buffer): string {
    return createHmac("sha256", secret).update(payload).digest("base64");
  }

  /**
   * Timing-safe string equality check to prevent timing attacks.
   */
  static timingSafeEqual(a: string, b: string): boolean {
    try {
      const bufA = Buffer.from(a);
      const bufB = Buffer.from(b);
      if (bufA.length !== bufB.length) return false;
      return timingSafeEqual(bufA, bufB);
    } catch {
      return false;
    }
  }
}
