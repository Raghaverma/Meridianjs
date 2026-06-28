import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { sanitizeObject } from "./observability-sanitizer.js";
import { sanitizeRequestOptions } from "./request-sanitizer.js";
import { redactSecrets } from "./secret-redactor.js";

/**
 * Property-based tests for the secret-redaction layer: regardless of where a
 * credential-shaped string is embedded (arbitrary key name, arbitrary
 * surrounding text, arbitrary nesting), it must never survive redaction.
 * This is the gap key-name-based redaction alone can't close — see
 * secret-redactor.ts for the patterns and the gap they cover.
 */

const openAiKey = fc.stringMatching(/^[A-Za-z0-9_-]{20,40}$/).map((suffix) => `sk-${suffix}`);

const awsAccessKeyId = fc.stringMatching(/^[A-Z0-9]{16}$/).map((suffix) => `AKIA${suffix}`);

const jwt = fc
  .tuple(
    fc.stringMatching(/^[A-Za-z0-9_-]{6,20}$/),
    fc.stringMatching(/^[A-Za-z0-9_-]{6,40}$/),
    fc.stringMatching(/^[A-Za-z0-9_-]{6,40}$/),
  )
  .map(([h, p, s]) => `eyJ${h}.${p}.${s}`);

const bearerToken = fc
  .stringMatching(/^[A-Za-z0-9._~+/=-]{8,40}$/)
  .map((token) => `Bearer ${token}`);

const privateKeyBlock = fc
  .stringMatching(/^[A-Za-z0-9+/=\s]{20,80}$/)
  .map((body) => `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`);

const anySecret = fc.oneof(openAiKey, awsAccessKeyId, jwt, bearerToken, privateKeyBlock);

function noSecretLeaked(text: string): boolean {
  return (
    !/\bsk-[A-Za-z0-9_-]{16,}\b/.test(text) &&
    !/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/.test(text) &&
    !/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/.test(text) &&
    !/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*-----END [A-Z0-9 ]*PRIVATE KEY-----/.test(text)
  );
}

describe("property: redactSecrets", () => {
  it("never leaks a credential-shaped secret embedded anywhere in free text", () => {
    fc.assert(
      fc.property(fc.string(), anySecret, fc.string(), (prefix, secret, suffix) => {
        const redacted = redactSecrets(`${prefix}${secret}${suffix}`);
        expect(noSecretLeaked(redacted)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it("is idempotent — redacting already-redacted text changes nothing further", () => {
    fc.assert(
      fc.property(fc.string(), anySecret, (prefix, secret) => {
        const once = redactSecrets(`${prefix}${secret}`);
        const twice = redactSecrets(once);
        expect(twice).toBe(once);
      }),
      { numRuns: 100 },
    );
  });

  it("leaves ordinary text untouched", () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => noSecretLeaked(s) && !/Bearer\s+\S{8,}/.test(s)),
        (text) => {
          expect(redactSecrets(text)).toBe(text);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("property: sanitizeObject never leaks a secret under an arbitrary key", () => {
  it("redacts a secret nested under any non-sensitive key name, at any depth", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 12 }).filter((k) => !/auth|cookie|token|key/i.test(k)),
        anySecret,
        (key, secret) => {
          const sanitized = sanitizeObject({ [key]: { nested: secret } });
          expect(noSecretLeaked(JSON.stringify(sanitized))).toBe(true);
        },
      ),
      { numRuns: 150 },
    );
  });
});

describe("property: sanitizeRequestOptions never leaks a secret in headers, query, or body", () => {
  it("redacts a secret value under an arbitrary header name", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 12 }).filter((k) => !/auth|cookie|token|key/i.test(k)),
        anySecret,
        (headerName, secret) => {
          const result = sanitizeRequestOptions({ headers: { [headerName]: secret } });
          expect(noSecretLeaked(JSON.stringify(result.headers))).toBe(true);
        },
      ),
      { numRuns: 150 },
    );
  });

  it("redacts a secret value embedded in an arbitrary JSON body shape", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 12 }).filter((k) => !/auth|cookie|token|key/i.test(k)),
        anySecret,
        (fieldName, secret) => {
          const result = sanitizeRequestOptions({ body: { [fieldName]: secret } });
          expect(noSecretLeaked(JSON.stringify(result.body))).toBe(true);
        },
      ),
      { numRuns: 150 },
    );
  });
});
