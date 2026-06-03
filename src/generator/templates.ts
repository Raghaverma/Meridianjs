export interface GeneratorContext {
  provider: string;
  baseUrl: string;
  authType: "apiKey" | "bearer" | "basic" | "oauth2";
  authKeyName: string;
  endpoints: Array<{ method: string; path: string; operationId?: string }>;
}

function pascal(name: string): string {
  return name
    .split(/[-_\s]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
}

function authHeaderLine(ctx: GeneratorContext): string {
  if (ctx.authType === "basic") {
    return `"Authorization": \`Basic \${Buffer.from(\`\${authToken.token}:\${authToken.secret ?? ""}\`).toString("base64")}\``;
  }
  return '"Authorization": `Bearer ${authToken.token}`';
}

function authStrategyBody(ctx: GeneratorContext): string {
  const className = `${pascal(ctx.provider)}`;
  if (ctx.authType === "basic") {
    return `    const user = config.username ?? config.apiKey ?? "";
    const pass = config.password ?? "";
    if (!user) throw new Error("${className}: username or apiKey is required");
    return { token: user, secret: pass };`;
  }
  return `    const key = config.apiKey ?? config.token ?? "";
    if (!key) throw new Error("${className}: apiKey or token is required");
    return { token: key };`;
}

function endpointComments(ctx: GeneratorContext): string {
  if (ctx.endpoints.length === 0) return "";
  const lines = ctx.endpoints
    .slice(0, 20)
    .map(
      (e) => `  //   ${e.method.padEnd(7)} ${e.path}${e.operationId ? ` (${e.operationId})` : ""}`,
    )
    .join("\n");
  return `\n  // Known endpoints from OpenAPI spec:\n${lines}\n`;
}

export function generateAdapter(ctx: GeneratorContext): string {
  const name = pascal(ctx.provider);
  return `import { ResponseNormalizer } from "../../core/normalizer.js";
import type {
  AdapterInput,
  AuthConfig,
  AuthToken,
  BuiltRequest,
  IdempotencyConfig,
  NormalizedResponse,
  PaginationStrategy,
  ProviderAdapter,
  RateLimitInfo,
  RawResponse,
} from "../../core/types.js";
import { MeridianError, SDK_VERSION } from "../../core/types.js";
import { ${name}PaginationStrategy } from "./pagination.js";
${endpointComments(ctx)}
export class ${name}Adapter implements ProviderAdapter {
  private baseUrl: string;

  constructor(baseUrl = "${ctx.baseUrl}") {
    this.baseUrl = baseUrl;
  }

  buildRequest(input: AdapterInput): BuiltRequest {
    const { endpoint, options, authToken, baseUrl } = input;
    const effectiveBaseUrl = baseUrl ?? this.baseUrl;

    const url = new URL(endpoint, effectiveBaseUrl);

    if (options.query) {
      for (const [key, value] of Object.entries(options.query)) {
        url.searchParams.set(key, String(value));
      }
    }

    const headers: Record<string, string> = {
      ${authHeaderLine(ctx)},
      "User-Agent": \`Meridian-SDK/\${SDK_VERSION}\`,
      "Content-Type": "application/json",
      ...options.headers,
    };

    let body: string | undefined;
    const method = options.method ?? "GET";
    if (options.body && method !== "GET" && method !== "HEAD") {
      body = JSON.stringify(options.body);
    }

    const built: BuiltRequest = { url: url.toString(), method, headers };
    if (body !== undefined) built.body = body;
    return built;
  }

  parseResponse(raw: RawResponse): NormalizedResponse {
    const rateLimitInfo = this.rateLimitPolicy(raw.headers);
    const paginationInfo = ResponseNormalizer.extractPaginationInfo(raw, this.paginationStrategy());
    return ResponseNormalizer.normalize(raw, "${ctx.provider}", rateLimitInfo, paginationInfo);
  }

  parseError(raw: unknown): MeridianError {
    if (typeof raw === "object" && raw !== null && "status" in raw) {
      const status = (raw as { status: number }).status;
      const body = (raw as { body?: unknown }).body;

      // TODO: extract provider-specific error message from body
      const message =
        typeof body === "object" && body !== null && "message" in body
          ? String((body as { message: unknown }).message)
          : \`HTTP \${status}\`;

      if (status === 401 || status === 403) {
        return new MeridianError(message, "auth", "${ctx.provider}", false, "", {}, undefined, status);
      }
      if (status === 429) {
        return new MeridianError(message, "rate_limit", "${ctx.provider}", true, "", {}, undefined, status);
      }
      if (status >= 400 && status < 500) {
        return new MeridianError(message, "validation", "${ctx.provider}", false, "", {}, undefined, status);
      }
      if (status >= 500) {
        return new MeridianError(message, "provider", "${ctx.provider}", true, "", {}, undefined, status);
      }
    }
    if (raw instanceof Error) {
      return new MeridianError(raw.message, "network", "${ctx.provider}", true);
    }
    return new MeridianError("Unknown error", "provider", "${ctx.provider}", false);
  }

  async authStrategy(config: AuthConfig): Promise<AuthToken> {
${authStrategyBody(ctx)}
  }

  rateLimitPolicy(headers: Headers): RateLimitInfo {
    // TODO: verify ${ctx.provider} rate-limit header names
    const reset = Number(headers.get("x-ratelimit-reset") ?? headers.get("x-rate-limit-reset") ?? 0);
    return {
      limit: Number(headers.get("x-ratelimit-limit") ?? headers.get("x-rate-limit-limit") ?? 100),
      remaining: Number(
        headers.get("x-ratelimit-remaining") ?? headers.get("x-rate-limit-remaining") ?? 100,
      ),
      reset: new Date(reset > 1_000_000_000 ? reset * 1000 : Date.now() + 60_000),
    };
  }

  paginationStrategy(): PaginationStrategy {
    return new ${name}PaginationStrategy();
  }

  getIdempotencyConfig(): IdempotencyConfig {
    return {
      defaultSafeOperations: new Set(["GET", "HEAD"]),
      operationOverrides: new Map(),
    };
  }
}
`;
}

export function generatePagination(ctx: GeneratorContext): string {
  const name = pascal(ctx.provider);
  return `import type { PaginationStrategy, RawResponse, RequestOptions } from "../../core/types.js";

export class ${name}PaginationStrategy implements PaginationStrategy {
  extractCursor(response: RawResponse): string | null {
    // TODO: update with actual ${ctx.provider} pagination field names
    const body = response.body as Record<string, unknown>;
    return (body.next_cursor as string) ?? (body.cursor as string) ?? (body.next as string) ?? null;
  }

  extractTotal(response: RawResponse): number | null {
    const body = response.body as Record<string, unknown>;
    return typeof body.total === "number" ? body.total : null;
  }

  hasNext(response: RawResponse): boolean {
    return this.extractCursor(response) !== null;
  }

  buildNextRequest(
    endpoint: string,
    options: RequestOptions,
    cursor: string,
  ): { endpoint: string; options: RequestOptions } {
    // TODO: update with the actual ${ctx.provider} cursor param name
    return {
      endpoint,
      options: { ...options, query: { ...options.query, cursor } },
    };
  }
}
`;
}

export function generateIndex(ctx: GeneratorContext): string {
  const name = pascal(ctx.provider);
  return `export { ${name}Adapter } from "./adapter.js";
`;
}

export function generateTest(ctx: GeneratorContext): string {
  const name = pascal(ctx.provider);
  const authArg =
    ctx.authType === "basic"
      ? "{ username: 'testuser', password: 'testpass' }"
      : "{ apiKey: 'test-key' }";

  return `import { describe, expect, it } from "vitest";
import { ${name}Adapter } from "./adapter.js";

const adapter = new ${name}Adapter();

describe("${name}Adapter", () => {
  describe("buildRequest", () => {
    it("builds a GET request with auth header", () => {
      const req = adapter.buildRequest({
        endpoint: "/test",
        options: { method: "GET" },
        authToken: { token: "test-key" },
      });
      expect(req.url).toContain("/test");
      expect(req.method).toBe("GET");
      expect(req.headers["Authorization"]).toBeDefined();
    });

    it("appends query parameters", () => {
      const req = adapter.buildRequest({
        endpoint: "/test",
        options: { method: "GET", query: { page: 1, limit: 10 } },
        authToken: { token: "test-key" },
      });
      expect(req.url).toContain("page=1");
      expect(req.url).toContain("limit=10");
    });

    it("serialises POST body as JSON", () => {
      const req = adapter.buildRequest({
        endpoint: "/test",
        options: { method: "POST", body: { name: "test" } },
        authToken: { token: "test-key" },
      });
      expect(req.body).toBe(JSON.stringify({ name: "test" }));
    });

    it("omits body for GET requests", () => {
      const req = adapter.buildRequest({
        endpoint: "/test",
        options: { method: "GET", body: { should: "be-ignored" } },
        authToken: { token: "test-key" },
      });
      expect(req.body).toBeUndefined();
    });
  });

  describe("parseError", () => {
    it("returns auth error for 401", () => {
      const err = adapter.parseError({ status: 401, headers: new Headers(), body: {} });
      expect(err.category).toBe("auth");
      expect(err.retryable).toBe(false);
    });

    it("returns auth error for 403", () => {
      const err = adapter.parseError({ status: 403, headers: new Headers(), body: {} });
      expect(err.category).toBe("auth");
    });

    it("returns rate_limit error for 429", () => {
      const err = adapter.parseError({ status: 429, headers: new Headers(), body: {} });
      expect(err.category).toBe("rate_limit");
      expect(err.retryable).toBe(true);
    });

    it("returns retryable provider error for 500", () => {
      const err = adapter.parseError({ status: 500, headers: new Headers(), body: {} });
      expect(err.category).toBe("provider");
      expect(err.retryable).toBe(true);
    });

    it("extracts message from error body", () => {
      const err = adapter.parseError({
        status: 400,
        headers: new Headers(),
        body: { message: "Invalid request" },
      });
      expect(err.message).toBe("Invalid request");
    });
  });

  describe("authStrategy", () => {
    it("throws when no credentials provided", async () => {
      await expect(adapter.authStrategy({})).rejects.toThrow();
    });

    it("resolves token from config", async () => {
      const token = await adapter.authStrategy(${authArg});
      expect(token.token).toBeTruthy();
    });
  });
});
`;
}
