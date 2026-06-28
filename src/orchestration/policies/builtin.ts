import type { Policy, PolicyContext, PolicyDecision } from "../../core/types.js";

const PII_PATTERNS = [
  /\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/, // credit card
  /\b\d{3}-\d{2}-\d{4}\b/, // SSN (US)
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/, // email
  /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/, // phone (US)
  /\b[A-Z]{5}\d{4}[A-Z]\b/, // PAN (India)
  /\b\d{12}\b/, // Aadhaar
];

function containsPII(value: unknown): boolean {
  const str = JSON.stringify(value);
  return PII_PATTERNS.some((p) => p.test(str));
}

/**
 * Block requests that contain detected PII from being sent to the given providers.
 * If `blockedProviders` is omitted, PII is blocked for all providers.
 */
export function blockPII(blockedProviders?: string[]): Policy {
  return {
    name: "block-pii",
    evaluate(ctx: PolicyContext): PolicyDecision {
      if (blockedProviders && !blockedProviders.includes(ctx.provider)) {
        return { allow: true };
      }
      if (containsPII(ctx.body) || containsPII(ctx.query)) {
        return {
          allow: false,
          reason: `PII detected in request body/query to provider "${ctx.provider}"`,
        };
      }
      return { allow: true };
    },
  };
}

/**
 * Only allow requests to the specified providers. All others are blocked.
 */
export function allowedProviders(providers: string[]): Policy {
  const allowed = new Set(providers);
  return {
    name: "allowed-providers",
    evaluate(ctx: PolicyContext): PolicyDecision {
      if (!allowed.has(ctx.provider)) {
        return {
          allow: false,
          reason: `Provider "${ctx.provider}" is not in the allowed list: [${providers.join(", ")}]`,
        };
      }
      return { allow: true };
    },
  };
}

/**
 * Block requests to the specified providers entirely.
 */
export function blockedProviders(providers: string[]): Policy {
  const blocked = new Set(providers);
  return {
    name: "blocked-providers",
    evaluate(ctx: PolicyContext): PolicyDecision {
      if (blocked.has(ctx.provider)) {
        return { allow: false, reason: `Provider "${ctx.provider}" is blocked by policy` };
      }
      return { allow: true };
    },
  };
}

/**
 * Block write operations (POST/PUT/PATCH/DELETE) to the specified providers.
 * Useful for read-only audit environments.
 */
export function readOnly(providers?: string[]): Policy {
  const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
  return {
    name: "read-only",
    evaluate(ctx: PolicyContext): PolicyDecision {
      if (providers && !providers.includes(ctx.provider)) return { allow: true };
      if (WRITE_METHODS.has(ctx.method.toUpperCase())) {
        return {
          allow: false,
          reason: `Write method "${ctx.method}" is blocked by read-only policy for "${ctx.provider}"`,
        };
      }
      return { allow: true };
    },
  };
}

/**
 * Create a custom policy from a plain function.
 */
export function customPolicy(name: string, fn: (ctx: PolicyContext) => PolicyDecision): Policy {
  return { name, evaluate: fn };
}

/**
 * Redact specific field paths from the request body before it reaches the provider.
 * Supports dot-notation paths: "user.ssn", "card.number".
 * If `targetProviders` is omitted, redaction applies to all providers.
 */
export function redact(fields: string[], targetProviders?: string[]): Policy {
  function redactPath(obj: unknown, path: string[]): unknown {
    if (path.length === 0 || obj === null || typeof obj !== "object") return obj;
    const [head, ...tail] = path as [string, ...string[]];
    const copy = Array.isArray(obj) ? [...obj] : { ...(obj as Record<string, unknown>) };
    if (tail.length === 0) {
      (copy as Record<string, unknown>)[head] = "[REDACTED]";
    } else {
      (copy as Record<string, unknown>)[head] = redactPath(
        (obj as Record<string, unknown>)[head],
        tail,
      );
    }
    return copy;
  }

  return {
    name: "redact",
    evaluate(ctx: PolicyContext): PolicyDecision {
      if (targetProviders && !targetProviders.includes(ctx.provider)) {
        return { allow: true };
      }
      if (ctx.body === undefined) return { allow: true };
      let body: unknown = ctx.body;
      for (const field of fields) {
        body = redactPath(body, field.split("."));
      }
      return {
        allow: true,
        transform: () => ({ body }),
      };
    },
  };
}

/**
 * Block requests that are missing any of the specified fields in the body.
 * If `targetProviders` is omitted, applies to all providers.
 */
export function requireFields(fields: string[], targetProviders?: string[]): Policy {
  return {
    name: "require-fields",
    evaluate(ctx: PolicyContext): PolicyDecision {
      if (targetProviders && !targetProviders.includes(ctx.provider)) {
        return { allow: true };
      }
      if (ctx.body === null || typeof ctx.body !== "object" || ctx.body === undefined) {
        return {
          allow: false,
          reason: `Required fields [${fields.join(", ")}] missing — body is empty`,
        };
      }
      const body = ctx.body as Record<string, unknown>;
      for (const field of fields) {
        if (!(field in body) || body[field] === undefined || body[field] === null) {
          return { allow: false, reason: `Required field "${field}" is missing or null` };
        }
      }
      return { allow: true };
    },
  };
}

/**
 * Block requests where a country field matches a denied country code (ISO 3166-1 alpha-2).
 * Checks `body[field]` — defaults to checking "country", "country_code", and "countryCode".
 */
export function denyCountries(countryCodes: string[], field?: string): Policy {
  const denied = new Set(countryCodes.map((c) => c.toUpperCase()));
  const FIELDS = field ? [field] : ["country", "country_code", "countryCode"];

  return {
    name: "deny-countries",
    evaluate(ctx: PolicyContext): PolicyDecision {
      if (ctx.body === null || typeof ctx.body !== "object" || ctx.body === undefined) {
        return { allow: true };
      }
      const body = ctx.body as Record<string, unknown>;
      for (const f of FIELDS) {
        const val = typeof body[f] === "string" ? (body[f] as string).toUpperCase() : undefined;
        if (val && denied.has(val)) {
          return {
            allow: false,
            reason: `Requests from country "${val}" are not permitted by policy`,
          };
        }
      }
      return { allow: true };
    },
  };
}
