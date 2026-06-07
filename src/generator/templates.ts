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
/**
 * Looks for an error message under the field names most APIs use
 * (\`message\`, \`error\`, \`error.message\`, \`error_description\`, \`detail\`,
 * \`errors[0]\`/\`errors[0].message\`). Verify against ${ctx.provider}'s actual
 * error envelope and adjust if it uses a different shape.
 */
function extractErrorMessage(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;

  if (typeof b.message === "string") return b.message;
  if (typeof b.error === "string") return b.error;
  if (typeof b.error === "object" && b.error !== null) {
    const inner = (b.error as Record<string, unknown>).message;
    if (typeof inner === "string") return inner;
  }
  if (typeof b.error_description === "string") return b.error_description;
  if (typeof b.detail === "string") return b.detail;
  if (Array.isArray(b.errors) && b.errors.length > 0) {
    const [first] = b.errors as unknown[];
    if (typeof first === "string") return first;
    if (typeof first === "object" && first !== null) {
      const inner = (first as Record<string, unknown>).message;
      if (typeof inner === "string") return inner;
    }
  }
  return null;
}

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

      const message = extractErrorMessage(body) ?? \`HTTP \${status}\`;

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
    // Checks the header-naming conventions most providers use — X-RateLimit-*,
    // X-Rate-Limit-*, the RFC-draft RateLimit-*, and Retry-After as a fallback
    // for the reset time. Verify against ${ctx.provider}'s actual headers.
    const limit =
      headers.get("x-ratelimit-limit") ??
      headers.get("x-rate-limit-limit") ??
      headers.get("ratelimit-limit");
    const remaining =
      headers.get("x-ratelimit-remaining") ??
      headers.get("x-rate-limit-remaining") ??
      headers.get("ratelimit-remaining");
    const reset = Number(
      headers.get("x-ratelimit-reset") ??
        headers.get("x-rate-limit-reset") ??
        headers.get("ratelimit-reset") ??
        headers.get("retry-after") ??
        0,
    );

    return {
      limit: Number(limit ?? 100),
      remaining: Number(remaining ?? 100),
      reset: new Date(
        reset > 1_000_000_000 ? reset * 1000 : Date.now() + (reset > 0 ? reset * 1000 : 60_000),
      ),
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
    // Checks the cursor field conventions most providers use — top-level
    // (next_cursor / cursor / next / next_page), nested under meta/pagination,
    // and Relay-style page_info.end_cursor. Verify against ${ctx.provider}'s
    // actual pagination shape and adjust the field names accordingly.
    const body = (response.body ?? {}) as Record<string, unknown>;

    const direct = body.next_cursor ?? body.cursor ?? body.next ?? body.next_page;
    if (typeof direct === "string") return direct;

    const meta = body.meta as Record<string, unknown> | undefined;
    const metaCursor = meta?.next_cursor ?? meta?.cursor;
    if (typeof metaCursor === "string") return metaCursor;

    const pagination = body.pagination as Record<string, unknown> | undefined;
    const paginationCursor = pagination?.next_cursor ?? pagination?.cursor;
    if (typeof paginationCursor === "string") return paginationCursor;

    const pageInfo = body.page_info as Record<string, unknown> | undefined;
    if (pageInfo?.has_next_page === true && typeof pageInfo.end_cursor === "string") {
      return pageInfo.end_cursor;
    }

    return null;
  }

  extractTotal(response: RawResponse): number | null {
    const body = (response.body ?? {}) as Record<string, unknown>;
    if (typeof body.total === "number") return body.total;

    const meta = body.meta as Record<string, unknown> | undefined;
    if (typeof meta?.total === "number") return meta.total;

    return null;
  }

  hasNext(response: RawResponse): boolean {
    return this.extractCursor(response) !== null;
  }

  buildNextRequest(
    endpoint: string,
    options: RequestOptions,
    cursor: string,
  ): { endpoint: string; options: RequestOptions } {
    // "cursor" is the most common query-param name for cursor-based pagination
    // (Stripe, Slack, GitHub GraphQL, ...); verify against ${ctx.provider}'s
    // actual docs and rename if it expects e.g. "page[cursor]" or "after".
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
