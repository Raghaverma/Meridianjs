import type { Policy, PolicyContext, PolicyDecision } from "../core/types.js";

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
