import { MeridianError } from "./types.js";

/**
 * Guards against endpoint host-override (SSRF + credential exfiltration).
 *
 * Every adapter resolves request URLs with `new URL(endpoint, baseUrl)`. The
 * WHATWG URL parser silently discards the base host when the relative ref is an
 * absolute URL (`https://evil.com`) or protocol-relative (`//evil.com`). Because
 * the adapter then attaches the provider's real credentials to the outgoing
 * request, an untrusted endpoint string could redirect that request — and the
 * API key — to an attacker-controlled host.
 *
 * This validator runs once, centrally, before any adapter sees the endpoint, so
 * a single guard protects every provider. It rejects anything that could change
 * the resolved origin while allowing ordinary relative paths, query strings, and
 * fragments.
 *
 * Bypass forms accounted for (all verified against Node's URL parser):
 *  - absolute URLs, any scheme, case-insensitive:      "https://evil.com", "HTTP://evil.com"
 *  - protocol-relative:                                 "//evil.com/x"
 *  - backslash variants (parser treats "\" as "/"):     "\\evil.com", "/\evil.com", "https:\\evil.com"
 *  - control-char smuggling (parser strips tab/CR/LF):  "ht<TAB>tps://evil.com", "htt<LF>ps://evil.com"
 *  - leading-whitespace smuggling (parser trims):       "  https://evil.com"
 */

// A URL scheme: ALPHA *( ALPHA / DIGIT / "+" / "-" / "." ) ":"  (RFC 3986 §3.1).
const SCHEME_PREFIX = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/**
 * True if the string contains any C0 control character (U+0000–U+001F) or DEL
 * (U+007F). The URL parser removes tab/CR/LF from input before parsing, which can
 * smuggle a scheme past naive checks, so we reject any control character outright
 * — none are valid in a path passed to an SDK (a legitimate caller percent-encodes
 * them). Implemented with code-point inspection to avoid embedding control bytes.
 */
function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

/**
 * Returns true if `endpoint` is a safe relative reference that cannot override
 * the base origin when resolved with `new URL(endpoint, baseUrl)`.
 */
export function isSafeEndpoint(endpoint: unknown): endpoint is string {
  if (typeof endpoint !== "string") {
    return false;
  }

  // Reject control characters before any normalization — the URL parser would
  // strip them and potentially reveal a hidden scheme.
  if (hasControlChar(endpoint)) {
    return false;
  }

  // The parser trims leading/trailing C0-control-or-space and treats backslashes
  // as forward slashes for special schemes. Mirror that before inspecting.
  const normalized = endpoint.trim().replace(/\\/g, "/");

  // Protocol-relative reference: "//host/..." adopts the host directly.
  if (normalized.startsWith("//")) {
    return false;
  }

  // Absolute reference: a scheme can only appear before the first "/", "?", or
  // "#". If the leading segment carries a scheme, the origin can change.
  const leadingSegment = normalized.split(/[/?#]/, 1)[0] ?? "";
  if (SCHEME_PREFIX.test(leadingSegment)) {
    return false;
  }

  return true;
}

/**
 * Throws a `MeridianError` ("validation") when `endpoint` is not a safe relative
 * reference. Call this before handing the endpoint to an adapter.
 */
export function assertSafeEndpoint(endpoint: string, provider: string, requestId = ""): void {
  if (!isSafeEndpoint(endpoint)) {
    throw new MeridianError(
      "Endpoint must be a relative path. Absolute or protocol-relative URLs are rejected to " +
        "prevent redirecting authenticated requests to an unintended host.",
      "validation",
      provider,
      false,
      requestId,
    );
  }
}
