export interface GeneratorPagination {
  style: "cursor" | "offset" | "page";
  param: string;
  limitParam?: string;
  /** Whether the parameter was read from the OpenAPI spec or is a default. */
  source: "spec" | "default";
}

export interface GeneratorContext {
  provider: string;
  baseUrl: string;
  authType: "apiKey" | "bearer" | "basic" | "oauth2";
  authKeyName: string;
  endpoints: Array<{ method: string; path: string; operationId?: string }>;
  /** Spec-derived header name for apiKey auth (e.g. "X-Api-Key"). */
  apiKeyHeader?: string;
  /** Spec-derived query parameter name for apiKey auth (e.g. "api_key"). */
  apiKeyQuery?: string;
  /** Pagination parameter inferred from the OpenAPI spec. */
  pagination?: GeneratorPagination;
  /** Distinct HTTP status codes the spec documents across operations. */
  documentedStatuses?: number[];
  /** The array-valued property list responses wrap data in, when detected. */
  envelopeKey?: string | null;
  /** Import specifier for runProviderContract in the generated contract test. */
  contractImport?: string;
}

export interface CompletenessItem {
  aspect: string;
  source: "spec" | "default";
  detail: string;
}

export interface CompletenessReport {
  /** 0–100; how much of the adapter was derived from the spec vs assumed. */
  score: number;
  items: CompletenessItem[];
  todos: string[];
}

function pascal(name: string): string {
  return name
    .split(/[-_\s]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
}

function authHeaderLine(ctx: GeneratorContext): string | null {
  if (ctx.authType === "basic") {
    return `"Authorization": \`Basic \${Buffer.from(\`\${authToken.token}:\${authToken.secret ?? ""}\`).toString("base64")}\``;
  }
  if (ctx.apiKeyQuery) return null; // credential travels as a query parameter
  if (ctx.apiKeyHeader && ctx.apiKeyHeader.toLowerCase() !== "authorization") {
    return `${JSON.stringify(ctx.apiKeyHeader)}: authToken.token`;
  }
  return '"Authorization": `Bearer ${authToken.token}`';
}

function authStrategyBody(ctx: GeneratorContext): string {
  const provider = JSON.stringify(ctx.provider);
  if (ctx.authType === "basic") {
    return `    const user = config.username ?? config.apiKey ?? "";
    const pass = config.password ?? "";
    if (!user) {
      throw new MeridianError("username or apiKey is required", "auth", ${provider}, false);
    }
    return { token: user, secret: pass };`;
  }
  return `    const key = config.apiKey ?? config.token ?? "";
    if (!key) {
      throw new MeridianError("apiKey or token is required", "auth", ${provider}, false);
    }
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
  const more = ctx.endpoints.length > 20 ? `\n  //   … and ${ctx.endpoints.length - 20} more` : "";
  return `\n  // Known endpoints from OpenAPI spec:\n${lines}${more}\n`;
}

function errorStatusComment(ctx: GeneratorContext): string {
  const statuses = ctx.documentedStatuses ?? [];
  if (statuses.length === 0) {
    return `  // TODO(meridian-generator): the OpenAPI spec did not document error status
  // codes; the classification below uses universal HTTP semantics. Verify the
  // provider does not use non-standard codes (e.g. 200 with an error body).`;
  }
  const errors = statuses.filter((s) => s >= 400);
  const has429 = errors.includes(429);
  return `  // Status codes documented in the OpenAPI spec: ${statuses.join(", ")}.
  // ${
    has429
      ? "429 is documented, so the rate_limit mapping below is spec-confirmed."
      : "TODO(meridian-generator): 429 is not documented in the spec — verify how this provider signals rate limiting."
  }`;
}

function envelopeComment(ctx: GeneratorContext): string {
  if (!ctx.envelopeKey) return "";
  return `
    // Most list responses in the OpenAPI spec wrap data in a ${JSON.stringify(ctx.envelopeKey)}
    // array property; ResponseNormalizer passes the body through unchanged, so
    // consumers read \`response.data.${ctx.envelopeKey}\` for collections.`;
}

export function generateAdapter(ctx: GeneratorContext): string {
  const name = pascal(ctx.provider);
  const authHeader = authHeaderLine(ctx);
  const headerLines = [
    ...(authHeader ? [`      ${authHeader},`] : []),
    '      "User-Agent": `Meridian-SDK/${SDK_VERSION}`,',
    '      "Content-Type": "application/json",',
    "      ...options.headers,",
  ].join("\n");
  const queryAuthLine = ctx.apiKeyQuery
    ? `
    // The OpenAPI spec declares apiKey auth in the query string.
    url.searchParams.set(${JSON.stringify(ctx.apiKeyQuery)}, authToken.token);
`
    : "";

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
 * \`errors[0]\`/\`errors[0].message\`).
 * TODO(meridian-generator): verify against ${ctx.provider}'s actual error
 * envelope and adjust if it uses a different shape.
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
${queryAuthLine}
    if (options.query) {
      for (const [key, value] of Object.entries(options.query)) {
        url.searchParams.set(key, String(value));
      }
    }

    const headers: Record<string, string> = {
${headerLines}
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
    const paginationInfo = ResponseNormalizer.extractPaginationInfo(raw, this.paginationStrategy());${envelopeComment(ctx)}
    return ResponseNormalizer.normalize(raw, "${ctx.provider}", rateLimitInfo, paginationInfo);
  }

  parseError(raw: unknown): MeridianError {
${errorStatusComment(ctx)}
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
    // for the reset time.
    // TODO(meridian-generator): verify against ${ctx.provider}'s actual headers.
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

function cursorPagination(ctx: GeneratorContext, name: string): string {
  const param = ctx.pagination?.param ?? "cursor";
  const paramComment =
    ctx.pagination?.source === "spec"
      ? `// Cursor query parameter ${JSON.stringify(param)} derived from the OpenAPI spec.`
      : `// "cursor" is the most common query-param name for cursor-based pagination
    // (Stripe, Slack, GitHub GraphQL, ...).
    // TODO(meridian-generator): verify against ${ctx.provider}'s actual docs and
    // rename if it expects e.g. "page[cursor]" or "after".`;

  return `import type { PaginationStrategy, RawResponse, RequestOptions } from "../../core/types.js";

export class ${name}PaginationStrategy implements PaginationStrategy {
  extractCursor(response: RawResponse): string | null {
    // Checks the cursor field conventions most providers use — top-level
    // (next_cursor / cursor / next / next_page), nested under meta/pagination,
    // and Relay-style page_info.end_cursor.
    // TODO(meridian-generator): verify against ${ctx.provider}'s actual
    // pagination shape and adjust the field names accordingly.
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
    ${paramComment}
    return {
      endpoint,
      options: { ...options, query: { ...options.query, ${JSON.stringify(param)}: cursor } },
    };
  }
}
`;
}

function pageOrOffsetPagination(ctx: GeneratorContext, name: string): string {
  const pagination = ctx.pagination!;
  const param = pagination.param;
  const isPage = pagination.style === "page";
  const styleWord = isPage ? "Page-number" : "Offset";

  const extractBody = isPage
    ? `    const direct = body.next_page ?? body.nextPage;
    if (typeof direct === "string") return direct;
    if (typeof direct === "number") return String(direct);

    const page = typeof body.page === "number" ? body.page : null;
    const totalPages =
      typeof body.total_pages === "number"
        ? body.total_pages
        : typeof body.totalPages === "number"
          ? body.totalPages
          : null;
    if (page !== null && totalPages !== null && page < totalPages) return String(page + 1);

    return null;`
    : `    const direct = body.next_offset ?? body.nextOffset;
    if (typeof direct === "string") return direct;
    if (typeof direct === "number") return String(direct);

    const offset = typeof body.offset === "number" ? body.offset : null;
    const limit = typeof body.limit === "number" ? body.limit : null;
    const total = typeof body.total === "number" ? body.total : null;
    if (offset !== null && limit !== null && total !== null && offset + limit < total) {
      return String(offset + limit);
    }

    return null;`;

  return `import type { PaginationStrategy, RawResponse, RequestOptions } from "../../core/types.js";

export class ${name}PaginationStrategy implements PaginationStrategy {
  // ${styleWord} pagination inferred from the OpenAPI spec (query parameter
  // ${JSON.stringify(param)}). The response-side field names below are heuristics.
  // TODO(meridian-generator): verify against ${ctx.provider}'s response shape.
  extractCursor(response: RawResponse): string | null {
    const body = (response.body ?? {}) as Record<string, unknown>;

${extractBody}
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
    // ${JSON.stringify(param)} derived from the OpenAPI spec.
    return {
      endpoint,
      options: { ...options, query: { ...options.query, ${JSON.stringify(param)}: cursor } },
    };
  }
}
`;
}

export function generatePagination(ctx: GeneratorContext): string {
  const name = pascal(ctx.provider);
  if (ctx.pagination && ctx.pagination.style !== "cursor") {
    return pageOrOffsetPagination(ctx, name);
  }
  return cursorPagination(ctx, name);
}

export function generateIndex(ctx: GeneratorContext): string {
  const name = pascal(ctx.provider);
  return `export { ${name}Adapter } from "./adapter.js";
`;
}

export function generateContractTest(ctx: GeneratorContext): string {
  const name = pascal(ctx.provider);
  const importPath = ctx.contractImport ?? "meridianjs/contract";
  return `import { runProviderContract } from ${JSON.stringify(importPath)};
import { ${name}Adapter } from "./adapter.js";

// The universal Meridian provider contract — the same battery every built-in
// adapter passes (error normalization, retry semantics, rate-limit parsing,
// pagination, request shaping). Keep this green; provider-specific behavior
// belongs in adapter.test.ts.
runProviderContract(${JSON.stringify(ctx.provider)}, new ${name}Adapter());
`;
}

export function generateTest(ctx: GeneratorContext): string {
  const name = pascal(ctx.provider);
  const authArg =
    ctx.authType === "basic"
      ? "{ username: 'testuser', password: 'testpass' }"
      : "{ apiKey: 'test-key' }";

  const authAssertion = ctx.apiKeyQuery
    ? `expect(req.url).toContain("${ctx.apiKeyQuery}=test-key");`
    : ctx.apiKeyHeader && ctx.apiKeyHeader.toLowerCase() !== "authorization"
      ? `expect(req.headers[${JSON.stringify(ctx.apiKeyHeader)}]).toBeDefined();`
      : 'expect(req.headers["Authorization"]).toBeDefined();';

  return `import { describe, expect, it } from "vitest";
import { ${name}Adapter } from "./adapter.js";

const adapter = new ${name}Adapter();

describe("${name}Adapter", () => {
  describe("buildRequest", () => {
    it("builds a GET request with credentials attached", () => {
      const req = adapter.buildRequest({
        endpoint: "/test",
        options: { method: "GET" },
        authToken: { token: "test-key" },
      });
      expect(req.url).toContain("/test");
      expect(req.method).toBe("GET");
      ${authAssertion}
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

export function generateReport(ctx: GeneratorContext, completeness: CompletenessReport): string {
  const name = pascal(ctx.provider);
  const rows = completeness.items
    .map(
      (item) =>
        `| ${item.aspect} | ${item.source === "spec" ? "✅ from spec" : "⚠️ heuristic default"} | ${item.detail} |`,
    )
    .join("\n");
  const todos =
    completeness.todos.length > 0
      ? completeness.todos.map((t) => `- [ ] ${t}`).join("\n")
      : "- [x] Nothing outstanding — every aspect was derived from the spec.";

  return `# Generated adapter: ${ctx.provider}

> Generated by \`meridian add\`. **Completeness score: ${completeness.score}/100.**
> The score reflects how much of this adapter was derived from the provider's
> OpenAPI spec versus filled in with heuristic defaults. Every heuristic is
> marked with \`TODO(meridian-generator)\` in the source.

## What was inferred vs assumed

| Aspect | Source | Detail |
|---|---|---|
${rows}

## Before shipping

${todos}

## Wiring it up

Register the adapter when creating the client:

\`\`\`ts
import { Meridian } from "meridianjs";
import { ${name}Adapter } from "./providers/${ctx.provider}/index.js";

const meridian = await Meridian.create({
  localUnsafe: true, // or configure stateStorage for production
  providers: {
    ${ctx.provider}: {
      auth: { apiKey: process.env.${ctx.provider.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY ?? "" },
      adapter: new ${name}Adapter(),
    },
  },
});
\`\`\`

Run the generated tests:

\`\`\`bash
npx vitest run ${ctx.provider}
\`\`\`

\`contract.test.ts\` runs the same universal contract battery every built-in
Meridian adapter passes. It must stay green.
`;
}
