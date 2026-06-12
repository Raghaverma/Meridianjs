import { timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { sanitizeObject } from "../core/observability-sanitizer.js";
import { redactPii } from "../core/request-sanitizer.js";
import type { MeridianConfig, ProviderConfig } from "../core/types.js";

/**
 * Request headers forwarded upstream. The proxy injects provider credentials
 * itself, so client-supplied auth/cookie headers are intentionally dropped —
 * forwarding them would let a caller override the injected credential (adapters
 * spread `options.headers` after the Authorization header) or leak their own
 * secrets to the upstream provider. Everything not on this allowlist is stripped.
 */
export const DEFAULT_FORWARDED_HEADERS = new Set([
  "content-type",
  "content-language",
  "accept",
  "accept-language",
  "idempotency-key",
  "x-request-id",
]);

export function isLoopbackHost(host: string): boolean {
  return (
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "localhost" ||
    host === "[::1]" ||
    host.startsWith("127.")
  );
}

/** Constant-time string comparison that does not leak length via early return. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    // Compare against self to keep timing independent of the mismatch position,
    // then return false for the length difference.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export const SUPPORTED_PROVIDERS = [
  "github",
  "anthropic",
  "openai",
  "stripe",
  "razorpay",
  "cashfree",
  "payu",
  "juspay",
  "msg91",
  "exotel",
  "gupshup",
  "setu",
  "decentro",
  "shiprocket",
  "delhivery",
  "hyperverge",
  "digio",
  "karza",
  "idfy",
  "cleartax",
  "mapmyindia",
  "perfios",
  "twilio",
  "sendgrid",
  "mailgun",
  "vonage",
  "adyen",
  "braintree",
  "phonepe",
  "gemini",
  "auth0",
  "hubspot",
  "supabase",
  "checkout",
  "cohere",
  "klarna",
  "mistral",
  "mollie",
  "apollo",
] as const;

export const PROVIDER_CATEGORIES: Record<string, string[]> = {
  Payments: [
    "stripe",
    "razorpay",
    "cashfree",
    "payu",
    "juspay",
    "adyen",
    "braintree",
    "phonepe",
    "checkout",
    "klarna",
    "mollie",
  ],
  Comms: ["msg91", "exotel", "gupshup", "twilio", "sendgrid", "mailgun", "vonage"],
  "Banking/UPI": ["setu", "decentro"],

  Logistics: ["shiprocket", "delhivery"],
  KYC: ["hyperverge", "digio", "karza", "idfy", "auth0"],
  "Tax/Maps": ["cleartax", "mapmyindia", "perfios"],
  AI: ["anthropic", "openai", "gemini", "cohere", "mistral"],
  Dev: ["github", "hubspot", "supabase", "apollo"],
};

/** Options shared by every proxy transport (credentials, recording, auth, headers). */
export interface ProxyServerOptions {
  /** Port to listen on. Defaults to 4242. */
  port?: number;
  /** Host to bind to. Defaults to 127.0.0.1. */
  host?: string;
  /** Override credentials per provider. Falls back to environment variables. */
  providers?: Partial<Record<string, { token?: string; apiKey?: string }>>;
  /** If set, record all requests and responses to this file path as newline-delimited JSON. */
  recordTo?: string;
  /** If set, replay responses from this recording file instead of hitting live APIs. */
  replayFrom?: string;
  /**
   * Controls redaction applied to recorded payloads before they are written to
   * disk. Credentials (Authorization/token/api_key/cookie keys) are ALWAYS
   * redacted regardless of this setting. This flag governs the additional PII
   * pattern redaction (email/phone/card; plus Aadhaar/PAN/VPA/bank in india mode):
   *  - `true` (default): redact generic PII patterns.
   *  - `"india"`: also redact India-specific PII (DPDPA).
   *  - `false`: skip PII pattern redaction (credentials are still redacted).
   * Recording files remain sensitive — store and share them accordingly.
   */
  recordRedaction?: boolean | "india";
  /**
   * Shared secret required on every request (except Health). Callers present it
   * as gRPC metadata `authorization: Bearer <token>` or `x-proxy-token: <token>`.
   * Falls back to the `MERIDIAN_PROXY_TOKEN` env var. Strongly recommended for
   * any non-loopback bind. When unset, the proxy is open to anyone who can reach
   * the port.
   */
  authToken?: string;
  /**
   * Permit binding to a non-loopback host without an `authToken`. Off by default:
   * the server refuses to start in that configuration because it would expose
   * every configured provider's credentials to the network unauthenticated.
   */
  allowUnauthenticatedRemote?: boolean;
  /**
   * Additional request header names (lowercase) to forward upstream beyond the
   * safe defaults. `authorization` and `cookie` are never forwarded.
   */
  forwardHeaders?: string[];
}

export function buildMeridianConfig(opts: ProxyServerOptions): MeridianConfig {
  const cred = (providerName: string, optKey: "token" | "apiKey", envVar: string): string =>
    (opts.providers as Record<string, Record<string, string>> | undefined)?.[providerName]?.[
      optKey
    ] ??
    process.env[envVar] ??
    "";

  const providerConfigs: Record<string, ProviderConfig> = {
    github: { auth: { token: cred("github", "token", "GITHUB_TOKEN") } },
    anthropic: { auth: { apiKey: cred("anthropic", "apiKey", "ANTHROPIC_API_KEY") } },
    openai: { auth: { apiKey: cred("openai", "apiKey", "OPENAI_API_KEY") } },
    stripe: { auth: { apiKey: cred("stripe", "apiKey", "STRIPE_SECRET_KEY") } },
    razorpay: {
      auth: {
        username: process.env.RAZORPAY_KEY_ID ?? "",
        password: process.env.RAZORPAY_KEY_SECRET ?? "",
      },
    },
    cashfree: {
      auth: {
        custom: {
          clientId: process.env.CASHFREE_CLIENT_ID ?? "",
          clientSecret: process.env.CASHFREE_CLIENT_SECRET ?? "",
        },
      },
    },
    payu: {
      auth: {
        username: process.env.PAYU_MERCHANT_KEY ?? "",
        password: process.env.PAYU_MERCHANT_SALT ?? "",
      },
    },
    juspay: { auth: { apiKey: process.env.JUSPAY_API_KEY ?? "" } },
    msg91: { auth: { apiKey: process.env.MSG91_AUTH_KEY ?? "" } },
    exotel: {
      auth: {
        username: process.env.EXOTEL_SID ?? "",
        password: process.env.EXOTEL_API_KEY ?? "",
      },
    },
    gupshup: { auth: { apiKey: process.env.GUPSHUP_API_KEY ?? "" } },
    setu: { auth: { token: process.env.SETU_TOKEN ?? "" } },
    decentro: {
      auth: {
        custom: {
          clientId: process.env.DECENTRO_CLIENT_ID ?? "",
          clientSecret: process.env.DECENTRO_CLIENT_SECRET ?? "",
          moduleSecret: process.env.DECENTRO_MODULE_SECRET ?? "",
        },
      },
    },
    shiprocket: { auth: { token: process.env.SHIPROCKET_TOKEN ?? "" } },
    delhivery: { auth: { token: process.env.DELHIVERY_TOKEN ?? "" } },
    hyperverge: {
      auth: {
        custom: {
          appId: process.env.HYPERVERGE_APP_ID ?? "",
          appKey: process.env.HYPERVERGE_APP_KEY ?? "",
        },
      },
    },
    digio: {
      auth: {
        custom: {
          clientId: process.env.DIGIO_CLIENT_ID ?? "",
          clientSecret: process.env.DIGIO_CLIENT_SECRET ?? "",
        },
      },
    },
    karza: { auth: { apiKey: process.env.KARZA_API_KEY ?? "" } },
    idfy: {
      auth: {
        apiKey: process.env.IDFY_API_KEY ?? "",
        custom: { accountId: process.env.IDFY_ACCOUNT_ID ?? "" },
      },
    },
    cleartax: { auth: { token: process.env.CLEARTAX_AUTH_TOKEN ?? "" } },
    mapmyindia: { auth: { token: process.env.MAPMYINDIA_TOKEN ?? "" } },
    perfios: { auth: { apiKey: process.env.PERFIOS_API_KEY ?? "" } },
    twilio: {
      auth: {
        username: process.env.TWILIO_SID ?? "",
        password: process.env.TWILIO_AUTH_TOKEN ?? "",
      },
    },
    sendgrid: {
      auth: {
        apiKey: cred("sendgrid", "apiKey", "SENDGRID_API_KEY"),
      },
    },
    mailgun: {
      auth: {
        apiKey: cred("mailgun", "apiKey", "MAILGUN_API_KEY"),
      },
    },
    vonage: {
      auth: {
        apiKey: cred("vonage", "apiKey", "VONAGE_API_KEY"),
        apiSecret: process.env.VONAGE_API_SECRET ?? "",
      },
    },
    adyen: {
      auth: {
        apiKey: cred("adyen", "apiKey", "ADYEN_API_KEY"),
      },
    },
    gemini: {
      auth: {
        apiKey: cred("gemini", "apiKey", "GEMINI_API_KEY"),
      },
    },
    auth0: {
      auth: {
        token: cred("auth0", "token", "AUTH0_MANAGEMENT_TOKEN"),
      },
    },
    hubspot: {
      auth: {
        token: cred("hubspot", "token", "HUBSPOT_ACCESS_TOKEN"),
      },
    },
    supabase: {
      auth: {
        token: cred("supabase", "token", "SUPABASE_KEY"),
      },
    },
    braintree: {
      auth: {
        clientId: process.env.BRAINTREE_MERCHANT_ID ?? "",
        username: process.env.BRAINTREE_PUBLIC_KEY ?? "",
        password: process.env.BRAINTREE_PRIVATE_KEY ?? "",
      },
    },
    phonepe: {
      auth: {
        clientId: process.env.PHONEPE_MERCHANT_ID ?? "",
        apiKey: process.env.PHONEPE_SALT_KEY ?? "",
        password: process.env.PHONEPE_SALT_INDEX ?? "1",
      },
    },
    checkout: {
      auth: {
        apiKey: cred("checkout", "apiKey", "CHECKOUT_API_KEY"),
      },
    },
    cohere: {
      auth: {
        apiKey: cred("cohere", "apiKey", "COHERE_API_KEY"),
      },
    },
    klarna: {
      auth: {
        username: process.env.KLARNA_USERNAME ?? "",
        password: process.env.KLARNA_PASSWORD ?? "",
      },
    },
    mistral: {
      auth: {
        apiKey: cred("mistral", "apiKey", "MISTRAL_API_KEY"),
      },
    },
    mollie: {
      auth: {
        apiKey: cred("mollie", "apiKey", "MOLLIE_API_KEY"),
      },
    },
    apollo: {
      auth: {
        apiKey: cred("apollo", "apiKey", "APOLLO_API_KEY"),
      },
    },
  };

  return {
    providers: providerConfigs,
    localUnsafe: true,
  };
}

export function loadReplayMap(filePath: string): Map<string, unknown> {
  const map = new Map<string, unknown>();
  if (!existsSync(filePath)) {
    return map;
  }
  const lines = readFileSync(filePath, "utf8")
    .split("\n")
    .filter((l) => l.trim());
  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as {
        provider?: string;
        method?: string;
        endpoint?: string;
        response?: unknown;
      };
      if (entry.provider && entry.method && entry.endpoint) {
        const key = `${entry.provider}:${entry.method}:${entry.endpoint}`;
        map.set(key, entry.response);
      }
    } catch {
      // skip malformed lines
    }
  }
  return map;
}

/**
 * Redact a recorded payload before it is persisted. Credentials (token/api_key/
 * authorization/cookie keys) are always redacted via key-based redaction;
 * PII patterns are additionally redacted unless `recordRedaction` is `false`.
 */
export function sanitizeForRecord(value: unknown, recordRedaction: boolean | "india"): unknown {
  const credSafe = sanitizeObject(value);
  if (recordRedaction === false) {
    return credSafe;
  }
  return redactPii(credSafe, { indiaMode: recordRedaction === "india" });
}
