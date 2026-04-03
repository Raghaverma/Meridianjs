
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Meridian } from "../index.js";
import type { MeridianConfig, ProviderConfig, RequestOptions } from "../core/types.js";

const SUPPORTED_PROVIDERS = ["github", "anthropic", "openai", "stripe"] as const;
type SupportedProvider = (typeof SUPPORTED_PROVIDERS)[number];

export interface ProxyServerOptions {
  /** Port to listen on. Defaults to 4242. */
  port?: number;
  /** Host to bind to. Defaults to 127.0.0.1. */
  host?: string;
  /** Override credentials per provider. Falls back to environment variables. */
  providers?: Partial<Record<SupportedProvider, { token?: string; apiKey?: string }>>;
}

function buildMeridianConfig(opts: ProxyServerOptions): MeridianConfig {
  const providerConfigs: Record<string, ProviderConfig> = {
    github: {
      auth: {
        token:
          opts.providers?.github?.token ??
          process.env.GITHUB_TOKEN ??
          "",
      },
    },
    anthropic: {
      auth: {
        apiKey:
          opts.providers?.anthropic?.apiKey ??
          process.env.ANTHROPIC_API_KEY ??
          "",
      },
    },
    openai: {
      auth: {
        apiKey:
          opts.providers?.openai?.apiKey ??
          process.env.OPENAI_API_KEY ??
          "",
      },
    },
    stripe: {
      auth: {
        apiKey:
          opts.providers?.stripe?.apiKey ??
          process.env.STRIPE_SECRET_KEY ??
          "",
      },
    },
  };

  return {
    providers: providerConfigs,
    localUnsafe: true,
  };
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

  constructor(opts: ProxyServerOptions = {}) {
    this.opts = opts;
    this.port = opts.port ?? 4242;
    this.host = opts.host ?? "127.0.0.1";
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

    console.log(`[Boundary Proxy] Listening on http://${this.host}:${this.port}`);
    console.log(
      `[Boundary Proxy] Usage: http://${this.host}:${this.port}/<provider>/<endpoint>`
    );
    console.log(
      `[Boundary Proxy] Providers: ${SUPPORTED_PROVIDERS.join(", ")}`
    );
  }

  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${this.host}`);
    const parts = url.pathname.replace(/^\//, "").split("/");
    const provider = parts[0] as SupportedProvider;
    const endpoint = "/" + parts.slice(1).join("/");

    if (!provider) {
      sendJson(res, 400, {
        error: "Missing provider in path.",
        usage: `http://${this.host}:${this.port}/<provider>/<endpoint>`,
        providers: SUPPORTED_PROVIDERS,
      });
      return;
    }

    const providerClient = this.meridian?.provider(provider);
    if (!providerClient) {
      sendJson(res, 404, {
        error: `Unknown provider: "${provider}"`,
        providers: SUPPORTED_PROVIDERS,
      });
      return;
    }

    const method = (req.method ?? "GET").toUpperCase() as NonNullable<RequestOptions["method"]>;

    const query: Record<string, string> = {};
    url.searchParams.forEach((val, key) => {
      query[key] = val;
    });

    // Forward incoming headers, excluding hop-by-hop headers
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === "string" && k !== "host" && k !== "connection") {
        headers[k] = v;
      }
    }

    const body =
      method === "POST" || method === "PUT" || method === "PATCH"
        ? await readBody(req)
        : undefined;

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

      sendJson(res, 200, response);
    } catch (err: unknown) {
      const status =
        typeof (err as any)?.status === "number" ? (err as any).status : 502;
      sendJson(res, status, {
        error: err instanceof Error ? err.message : String(err),
        code: (err as any)?.code,
        category: (err as any)?.category,
        retryable: (err as any)?.retryable ?? false,
        provider,
      });
    }
  }
}
