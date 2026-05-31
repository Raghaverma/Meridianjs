import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { MeridianConfig, ProviderConfig, RequestOptions } from "../core/types.js";
import { Meridian } from "../index.js";

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
] as const;

const PROVIDER_CATEGORIES: Record<string, string[]> = {
  Payments: ["stripe", "razorpay", "cashfree", "payu", "juspay"],
  Comms: ["msg91", "exotel", "gupshup"],
  "Banking/UPI": ["setu", "decentro"],
  Logistics: ["shiprocket", "delhivery"],
  KYC: ["hyperverge", "digio", "karza", "idfy"],
  "Tax/Maps": ["cleartax", "mapmyindia", "perfios"],
  AI: ["anthropic", "openai"],
  Dev: ["github"],
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
}

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
        username: process.env["RAZORPAY_KEY_ID"] ?? "",
        password: process.env["RAZORPAY_KEY_SECRET"] ?? "",
      },
    },
    cashfree: {
      auth: {
        custom: {
          clientId: process.env["CASHFREE_CLIENT_ID"] ?? "",
          clientSecret: process.env["CASHFREE_CLIENT_SECRET"] ?? "",
        },
      },
    },
    payu: {
      auth: {
        username: process.env["PAYU_MERCHANT_KEY"] ?? "",
        password: process.env["PAYU_MERCHANT_SALT"] ?? "",
      },
    },
    juspay: { auth: { apiKey: process.env["JUSPAY_API_KEY"] ?? "" } },
    msg91: { auth: { apiKey: process.env["MSG91_AUTH_KEY"] ?? "" } },
    exotel: {
      auth: {
        username: process.env["EXOTEL_SID"] ?? "",
        password: process.env["EXOTEL_API_KEY"] ?? "",
      },
    },
    gupshup: { auth: { apiKey: process.env["GUPSHUP_API_KEY"] ?? "" } },
    setu: { auth: { token: process.env["SETU_TOKEN"] ?? "" } },
    decentro: {
      auth: {
        custom: {
          clientId: process.env["DECENTRO_CLIENT_ID"] ?? "",
          clientSecret: process.env["DECENTRO_CLIENT_SECRET"] ?? "",
          moduleSecret: process.env["DECENTRO_MODULE_SECRET"] ?? "",
        },
      },
    },
    shiprocket: { auth: { token: process.env["SHIPROCKET_TOKEN"] ?? "" } },
    delhivery: { auth: { token: process.env["DELHIVERY_TOKEN"] ?? "" } },
    hyperverge: {
      auth: {
        custom: {
          appId: process.env["HYPERVERGE_APP_ID"] ?? "",
          appKey: process.env["HYPERVERGE_APP_KEY"] ?? "",
        },
      },
    },
    digio: {
      auth: {
        custom: {
          clientId: process.env["DIGIO_CLIENT_ID"] ?? "",
          clientSecret: process.env["DIGIO_CLIENT_SECRET"] ?? "",
        },
      },
    },
    karza: { auth: { apiKey: process.env["KARZA_API_KEY"] ?? "" } },
    idfy: {
      auth: {
        apiKey: process.env["IDFY_API_KEY"] ?? "",
        custom: { accountId: process.env["IDFY_ACCOUNT_ID"] ?? "" },
      },
    },
    cleartax: { auth: { token: process.env["CLEARTAX_AUTH_TOKEN"] ?? "" } },
    mapmyindia: { auth: { token: process.env["MAPMYINDIA_TOKEN"] ?? "" } },
    perfios: { auth: { apiKey: process.env["PERFIOS_API_KEY"] ?? "" } },
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

async function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
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
  private replayMap: Map<string, unknown> = new Map();

  constructor(opts: ProxyServerOptions = {}) {
    this.opts = opts;
    this.port = opts.port ?? 4242;
    this.host = opts.host ?? "127.0.0.1";
    this.recordTo = opts.recordTo ?? process.env["MERIDIAN_RECORD_PATH"];
    this.replayFrom = opts.replayFrom ?? process.env["MERIDIAN_REPLAY_PATH"];

    if (this.replayFrom) {
      this.replayMap = loadReplayMap(this.replayFrom);
    }
  }

  async start(): Promise<void> {
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
    console.log(`[Meridian Proxy] ${SUPPORTED_PROVIDERS.length} providers available:`);
    for (const [category, providers] of Object.entries(PROVIDER_CATEGORIES)) {
      const label = `  ${category}:`.padEnd(16);
      console.log(`${label}${providers.join(", ")}`);
    }
    console.log(`[Meridian Proxy] Usage: ${baseUrl}/<provider>/<endpoint>`);
    console.log(`[Meridian Proxy] Record: set recordTo option or MERIDIAN_RECORD_PATH env var`);
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${this.host}`);
    const pathname = url.pathname;

    // Health endpoint — only /_health, not / (which is the missing-provider path)
    if (pathname === "/_health") {
      sendJson(res, 200, {
        status: "ok",
        providers: [...SUPPORTED_PROVIDERS],
        recording: Boolean(this.recordTo),
        replaying: Boolean(this.replayFrom),
      });
      return;
    }

    const parts = pathname.replace(/^\//, "").split("/");
    const provider = parts[0];
    const endpoint = "/" + parts.slice(1).join("/");

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

    // Forward incoming headers, excluding hop-by-hop headers
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === "string" && k !== "host" && k !== "connection") {
        headers[k] = v;
      }
    }

    const body =
      method === "POST" || method === "PUT" || method === "PATCH" ? await readBody(req) : undefined;

    const options: RequestOptions = { headers };
    options.method = method as NonNullable<RequestOptions["method"]>;
    if (Object.keys(query).length > 0) options.query = query;
    if (body !== undefined) options.body = body;

    try {
      let response;
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

      // Record if enabled
      if (this.recordTo) {
        const record = {
          ts: new Date().toISOString(),
          provider,
          endpoint,
          method,
          query,
          response,
        };
        try {
          appendFileSync(this.recordTo, JSON.stringify(record) + "\n", "utf8");
        } catch {
          // non-fatal: recording failure should not break the response
        }
      }

      sendJson(res, 200, response);
    } catch (err: unknown) {
      const status =
        typeof (err as Record<string, unknown>)?.["status"] === "number"
          ? ((err as Record<string, unknown>)["status"] as number)
          : 502;
      sendJson(res, status, {
        error: err instanceof Error ? err.message : String(err),
        code: (err as Record<string, unknown>)?.["code"],
        category: (err as Record<string, unknown>)?.["category"],
        retryable: (err as Record<string, unknown>)?.["retryable"] ?? false,
        provider,
      });
    }
  }
}
