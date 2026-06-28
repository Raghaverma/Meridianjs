/**
 * Pattern-based secret detection, independent of key names.
 *
 * The PII/key-name redaction in request-sanitizer.ts and observability-
 * sanitizer.ts only catches secrets sitting under an expected key
 * (Authorization, apiKey, ...). A credential embedded in a string under an
 * unrelated key — a Bearer token forwarded inside a custom header, an API
 * key echoed back in an error body, a private key pasted into a log field —
 * passes through untouched. These patterns catch the secret by its shape
 * instead, so redaction doesn't depend on the surrounding key being named
 * correctly.
 */

const SECRET_PATTERNS = {
  // PEM key blocks first: greedy enough to span newlines, but must not
  // outrun the matching END marker.
  PRIVATE_KEY_BLOCK:
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  // JWTs before bearer tokens, so a "Bearer <jwt>" string redacts the JWT
  // first and leaves the literal word "Bearer" instead of consuming it twice.
  JWT: /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g,
  BEARER_TOKEN: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  OPENAI_KEY: /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  AWS_ACCESS_KEY_ID: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASCA)[A-Z0-9]{16}\b/g,
};

const REPLACEMENT = "[SECRET-REDACTED]";

/** Redacts credential-shaped substrings from `text`, regardless of surrounding key names. */
export function redactSecrets(text: string): string {
  let result = text;
  result = result.replace(SECRET_PATTERNS.PRIVATE_KEY_BLOCK, REPLACEMENT);
  result = result.replace(SECRET_PATTERNS.JWT, REPLACEMENT);
  result = result.replace(SECRET_PATTERNS.BEARER_TOKEN, `Bearer ${REPLACEMENT}`);
  result = result.replace(SECRET_PATTERNS.OPENAI_KEY, REPLACEMENT);
  result = result.replace(SECRET_PATTERNS.AWS_ACCESS_KEY_ID, REPLACEMENT);
  return result;
}
