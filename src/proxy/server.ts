import { timingSafeEqual } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { sanitizeObject } from "../core/observability-sanitizer.js";
import { redactPii } from "../core/request-sanitizer.js";
import type { MeridianConfig, ProviderConfig, RequestOptions } from "../core/types.js";
import { Meridian } from "../index.js";

/**
 * Request headers forwarded upstream. The proxy injects provider credentials
 * itself, so client-supplied auth/cookie headers are intentionally dropped —
 * forwarding them would let a caller override the injected credential (adapters
 * spread `options.headers` after the Authorization header) or leak their own
 * secrets to the upstream provider. Everything not on this allowlist is stripped.
 */
const DEFAULT_FORWARDED_HEADERS = new Set([
  "content-type",
  "content-language",
  "accept",
  "accept-language",
  "idempotency-key",
  "x-request-id",
]);

function isLoopbackHost(host: string): boolean {
  return (
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "localhost" ||
    host === "[::1]" ||
    host.startsWith("127.")
  );
}

/** Constant-time string comparison that does not leak length via early return. */
function safeEqual(a: string, b: string): boolean {
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

const SUPPORTED_PROVIDERS = [
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

const PROVIDER_CATEGORIES: Record<string, string[]> = {
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
   * Shared secret required on every request (except `/_health`). Callers must
   * present it as `Authorization: Bearer <token>` or `X-Proxy-Token: <token>`.
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
  /**
   * Maximum incoming request body size in bytes. Requests exceeding this are
   * rejected with 413 before the body is fully buffered. Defaults to 10 MB.
   */
  maxBodyBytes?: number;
}

const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024;

function buildMeridianConfig(opts: ProxyServerOptions): MeridianConfig {
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

function loadReplayMap(filePath: string): Map<string, unknown> {
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

/** Marker error raised when an incoming request body exceeds the configured cap. */
class PayloadTooLargeError extends Error {
  readonly status = 413;
  constructor(maxBytes: number) {
    super(`Request body exceeds the ${maxBytes}-byte limit.`);
    this.name = "PayloadTooLargeError";
  }
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let aborted = false;

    req.on("data", (chunk: Buffer) => {
      if (aborted) return;
      total += chunk.length;
      // Reject early — don't buffer an unbounded amount of memory. Stop
      // accumulating but leave the socket open so the 413 response can flush;
      // remaining inbound chunks are discarded via the `aborted` guard.
      if (total > maxBytes) {
        aborted = true;
        chunks.length = 0;
        req.resume();
        reject(new PayloadTooLargeError(maxBytes));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (aborted) return;
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(raw);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

export class BoundaryProxyServer {
  private meridian: Meridian | null = null;
  private readonly port: number;
  private readonly host: string;
  private readonly opts: ProxyServerOptions;
  private readonly recordTo: string | undefined;
  private readonly replayFrom: string | undefined;
  private readonly recordRedaction: boolean | "india";
  private readonly authToken: string | undefined;
  private readonly allowUnauthenticatedRemote: boolean;
  private readonly forwardedHeaders: Set<string>;
  private readonly maxBodyBytes: number;
  private replayMap: Map<string, unknown> = new Map();

  constructor(opts: ProxyServerOptions = {}) {
    this.opts = opts;
    this.port = opts.port ?? 4242;
    this.host = opts.host ?? "127.0.0.1";
    this.recordTo = opts.recordTo ?? process.env.MERIDIAN_RECORD_PATH;
    this.replayFrom = opts.replayFrom ?? process.env.MERIDIAN_REPLAY_PATH;
    this.recordRedaction = opts.recordRedaction ?? true;
    this.authToken = opts.authToken ?? process.env.MERIDIAN_PROXY_TOKEN ?? undefined;
    this.allowUnauthenticatedRemote = opts.allowUnauthenticatedRemote ?? false;
    this.forwardedHeaders = new Set(DEFAULT_FORWARDED_HEADERS);
    for (const h of opts.forwardHeaders ?? []) {
      const lower = h.toLowerCase();
      // Never allow credential-bearing headers to be forwarded upstream.
      if (lower !== "authorization" && lower !== "cookie") {
        this.forwardedHeaders.add(lower);
      }
    }
    this.maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

    if (this.replayFrom) {
      this.replayMap = loadReplayMap(this.replayFrom);
    }
  }

  async start(): Promise<void> {
    const remoteBind = !isLoopbackHost(this.host);

    // Refuse to expose credentialed providers to the network without auth.
    if (remoteBind && !this.authToken && !this.allowUnauthenticatedRemote) {
      throw new Error(
        `[Meridian Proxy] Refusing to bind to non-loopback host "${this.host}" without an ` +
          "authToken. Anyone who can reach this port could spend your provider credentials. " +
          "Set `authToken` (or MERIDIAN_PROXY_TOKEN), bind to 127.0.0.1, or explicitly pass " +
          "`allowUnauthenticatedRemote: true` to override.",
      );
    }

    const config = buildMeridianConfig(this.opts);
    this.meridian = await Meridian.create(config);

    const server = createServer((req, res) => {
      this.handleRequest(req, res).catch((err: unknown) => {
        sendJson(res, 500, {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(this.port, this.host, resolve);
    });

    const baseUrl = `http://${this.host}:${this.port}`;
    console.log(`[Meridian Proxy] Listening on ${baseUrl}`);
    if (this.authToken) {
      console.log(
        "[Meridian Proxy] Auth: required (Authorization: Bearer <token> or X-Proxy-Token)",
      );
    } else {
      console.warn(
        "[Meridian Proxy] Auth: DISABLED — any caller that can reach this port can use your " +
          "provider credentials. Set authToken / MERIDIAN_PROXY_TOKEN to require a shared secret.",
      );
    }
    if (remoteBind) {
      console.warn(
        `[Meridian Proxy] WARNING: bound to non-loopback host "${this.host}". The proxy is ` +
          "reachable from the network. Ensure auth is enabled and the port is firewalled.",
      );
    }
    console.log(`[Meridian Proxy] ${SUPPORTED_PROVIDERS.length} providers available:`);
    for (const [category, providers] of Object.entries(PROVIDER_CATEGORIES)) {
      const label = `  ${category}:`.padEnd(16);
      console.log(`${label}${providers.join(", ")}`);
    }
    console.log(`[Meridian Proxy] Usage: ${baseUrl}/<provider>/<endpoint>`);
    console.log("[Meridian Proxy] Record: set recordTo option or MERIDIAN_RECORD_PATH env var");
    if (this.recordTo) {
      const piiMode =
        this.recordRedaction === false
          ? "credentials only"
          : this.recordRedaction === "india"
            ? "credentials + PII (india)"
            : "credentials + PII";
      console.log(
        `[Meridian Proxy] Recording to ${this.recordTo} (redaction: ${piiMode}). ` +
          "Recording files are sensitive — store and share them with care.",
      );
    }
  }

  /**
   * Redact a recorded payload before it is persisted. Credentials (token/api_key/
   * authorization/cookie keys) are always redacted via key-based redaction;
   * PII patterns are additionally redacted unless `recordRedaction` is `false`.
   */
  private sanitizeForRecord(value: unknown): unknown {
    const credSafe = sanitizeObject(value);
    if (this.recordRedaction === false) {
      return credSafe;
    }
    return redactPii(credSafe, { indiaMode: this.recordRedaction === "india" });
  }

  /**
   * Constant-time check that the request carries the configured proxy token,
   * via `Authorization: Bearer <token>` or `X-Proxy-Token: <token>`.
   */
  private isAuthorized(req: IncomingMessage): boolean {
    if (!this.authToken) {
      return true;
    }
    const authHeader = req.headers.authorization;
    if (typeof authHeader === "string") {
      const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
      if (match?.[1] && safeEqual(match[1], this.authToken)) {
        return true;
      }
    }
    const proxyToken = req.headers["x-proxy-token"];
    if (typeof proxyToken === "string" && safeEqual(proxyToken, this.authToken)) {
      return true;
    }
    return false;
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${this.host}`);
    const pathname = url.pathname;

    // Health endpoint — only /_health, not / (which is the missing-provider
    // path). Unauthenticated on purpose: it returns no secrets, only liveness.
    if (pathname === "/_health") {
      sendJson(res, 200, {
        status: "ok",
        providers: [...SUPPORTED_PROVIDERS],
        recording: Boolean(this.recordTo),
        replaying: Boolean(this.replayFrom),
        authRequired: Boolean(this.authToken),
      });
      return;
    }

    // Enforce the shared-secret if configured. Everything below this point can
    // spend provider credentials, so it must be authenticated.
    if (this.authToken && !this.isAuthorized(req)) {
      sendJson(res, 401, {
        error:
          "Unauthorized. Provide the proxy token via 'Authorization: Bearer <token>' or " +
          "'X-Proxy-Token: <token>'.",
      });
      return;
    }

    const parts = pathname.replace(/^\//, "").split("/");
    const provider = parts[0];
    const endpoint = `/${parts.slice(1).join("/")}`;

    if (!provider) {
      sendJson(res, 400, {
        error: "Missing provider in path.",
        usage: `http://${this.host}:${this.port}/<provider>/<endpoint>`,
        providers: [...SUPPORTED_PROVIDERS],
      });
      return;
    }

    const providerClient = this.meridian?.provider(provider);
    if (!providerClient) {
      sendJson(res, 404, {
        error: `Unknown provider: "${provider}"`,
        providers: [...SUPPORTED_PROVIDERS],
      });
      return;
    }

    const method = (req.method ?? "GET").toUpperCase() as NonNullable<RequestOptions["method"]>;

    const query: Record<string, string> = {};
    url.searchParams.forEach((val, key) => {
      query[key] = val;
    });

    // Check replay map before hitting live API
    const replayKey = `${provider}:${method}:${endpoint}`;
    if (this.replayFrom && this.replayMap.has(replayKey)) {
      sendJson(res, 200, this.replayMap.get(replayKey));
      return;
    }

    // Forward only allowlisted headers. The proxy injects provider credentials
    // itself, so client-supplied auth/cookie headers are never forwarded — doing
    // so would let a caller override the injected credential or leak their own.
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === "string" && this.forwardedHeaders.has(k.toLowerCase())) {
        headers[k] = v;
      }
    }

    let body: unknown;
    if (method === "POST" || method === "PUT" || method === "PATCH") {
      try {
        body = await readBody(req, this.maxBodyBytes);
      } catch (err) {
        if (err instanceof PayloadTooLargeError) {
          sendJson(res, 413, { error: err.message });
          return;
        }
        throw err;
      }
    }

    const options: RequestOptions = { headers };
    options.method = method as NonNullable<RequestOptions["method"]>;
    if (Object.keys(query).length > 0) options.query = query;
    if (body !== undefined) options.body = body;

    try {
      let response: unknown;
      switch (method) {
        case "POST":
          response = await providerClient.post(endpoint, options);
          break;
        case "PUT":
          response = await providerClient.put(endpoint, options);
          break;
        case "PATCH":
          response = await providerClient.patch(endpoint, options);
          break;
        case "DELETE":
          response = await providerClient.delete(endpoint, options);
          break;
        default:
          response = await providerClient.get(endpoint, options);
      }

      // Record if enabled. Sanitize before writing so credentials and PII never
      // land on disk in plaintext.
      if (this.recordTo) {
        const record = {
          ts: new Date().toISOString(),
          provider,
          endpoint,
          method,
          query: this.sanitizeForRecord(query),
          response: this.sanitizeForRecord(response),
        };
        try {
          appendFileSync(this.recordTo, `${JSON.stringify(record)}\n`, "utf8");
        } catch {
          // non-fatal: recording failure should not break the response
        }
      }

      sendJson(res, 200, response);
    } catch (err: unknown) {
      const status =
        typeof (err as Record<string, unknown>)?.status === "number"
          ? ((err as Record<string, unknown>).status as number)
          : 502;
      sendJson(res, status, {
        error: err instanceof Error ? err.message : String(err),
        code: (err as Record<string, unknown>)?.code,
        category: (err as Record<string, unknown>)?.category,
        retryable: (err as Record<string, unknown>)?.retryable ?? false,
        provider,
      });
    }
  }
}
