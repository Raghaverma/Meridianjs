# Adapters Guide

Adapters act as translation layers between the Meridian request pipeline and individual third-party APIs. Meridian includes 39 pre-built adapters, but you can easily write your own custom adapter to normalize any API.

---

## The `ProviderAdapter` Contract

A custom adapter must implement the `ProviderAdapter` interface defined in `meridianjs`:

```typescript
import type { 
  ProviderAdapter, 
  AdapterInput, 
  BuiltRequest, 
  RawResponse, 
  NormalizedResponse, 
  AuthConfig, 
  AuthToken, 
  RateLimitInfo, 
  PaginationStrategy, 
  IdempotencyConfig 
} from "meridianjs";
import { MeridianError } from "meridianjs";

export class MyCustomAdapter implements ProviderAdapter {
  // 1. Build request options mapped to the provider's specific API requirements
  buildRequest(input: AdapterInput): BuiltRequest {
    const { endpoint, options, authToken, baseUrl } = input;
    const url = new URL(endpoint, baseUrl ?? "https://api.myprovider.com");
    
    if (options.query) {
      for (const [k, v] of Object.entries(options.query)) {
        url.searchParams.set(k, String(v));
      }
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${authToken.token}`,
      "Content-Type": "application/json",
      ...options.headers
    };

    const built: BuiltRequest = {
      url: url.toString(),
      method: options.method ?? "GET",
      headers
    };

    if (options.body && built.method !== "GET" && built.method !== "HEAD") {
      built.body = JSON.stringify(options.body);
    }

    return built;
  }

  // 2. Normalize a successful response into the standard structure
  parseResponse(raw: RawResponse): NormalizedResponse {
    const rateLimit = this.rateLimitPolicy(raw.headers);
    const pagination = this.paginationStrategy().hasNext(raw) 
      ? { hasNext: true, cursor: this.paginationStrategy().extractCursor(raw) || undefined }
      : undefined;

    return {
      data: raw.body,
      meta: {
        provider: "my-custom-provider",
        requestId: raw.headers.get("x-request-id") || "unknown",
        rateLimit,
        pagination,
        warnings: [],
        schemaVersion: "1.0.0"
      }
    };
  }

  // 3. Normalize HTTP error statuses and envelopes into a standard MeridianError
  parseError(raw: unknown): MeridianError {
    if (raw instanceof Error) {
      return new MeridianError(raw.message, "network", "my-custom-provider", true);
    }

    const httpError = raw as { status: number; headers?: Headers; body?: any };
    const status = httpError.status;
    const body = httpError.body;
    const message = body?.error?.message || body?.message || "An error occurred";

    if (status === 401 || status === 403) {
      return new MeridianError(message, "auth", "my-custom-provider", false, undefined, undefined, undefined, status);
    }
    if (status === 429) {
      return new MeridianError(message, "rate_limit", "my-custom-provider", true, undefined, undefined, undefined, status);
    }
    if (status >= 500) {
      return new MeridianError(message, "provider", "my-custom-provider", true, undefined, undefined, undefined, status);
    }

    return new MeridianError(message, "validation", "my-custom-provider", false, undefined, undefined, undefined, status);
  }

  // 4. Resolve credential configs into standard tokens
  async authStrategy(config: AuthConfig): Promise<AuthToken> {
    if (!config.apiKey) {
      throw new MeridianError("API Key is required", "auth", "my-custom-provider", false);
    }
    return { token: config.apiKey };
  }

  // 5. Parse standard rate limit headers
  rateLimitPolicy(headers: Headers): RateLimitInfo {
    const limit = Number(headers.get("x-ratelimit-limit") || "100");
    const remaining = Number(headers.get("x-ratelimit-remaining") || "100");
    return {
      limit,
      remaining,
      reset: new Date(Date.now() + 60000)
    };
  }

  // 6. Provide pagination behavior pointers
  paginationStrategy(): PaginationStrategy {
    return {
      extractCursor(response) {
        return (response.body as any)?.next_cursor || null;
      },
      extractTotal(response) {
        return (response.body as any)?.total_count || null;
      },
      hasNext(response) {
        return !!this.extractCursor(response);
      },
      buildNextRequest(endpoint, options, cursor) {
        return {
          endpoint,
          options: {
            ...options,
            query: { ...options.query, cursor }
          }
        };
      }
    };
  }

  // 7. Outline safe and conditionally idempotent operations
  getIdempotencyConfig(): IdempotencyConfig {
    return {
      defaultSafeOperations: new Set(["GET", "HEAD", "OPTIONS"]),
      operationOverrides: new Map()
    };
  }
}
```

---

## Registering Your Adapter

You can supply your custom adapter instance inside the configuration when creating the Meridian client:

```typescript
import { Meridian } from "meridianjs";
import { MyCustomAdapter } from "./my-custom-adapter.js";

const meridian = await Meridian.create({
  providers: {
    "my-custom-provider": {
      auth: { apiKey: "key_abc123" },
      adapter: new MyCustomAdapter() // register here!
    }
  },
  localUnsafe: true
});

// Use it exactly like any built-in provider
const response = await meridian.provider("my-custom-provider").get("/v1/items");
```

---

## Verifying Your Adapter Against the Contract

Adapters are just data sources — the resilience guarantees Meridian makes (error
normalization, retry semantics, rate-limit parsing, pagination, request shaping)
must hold identically for every one of them. Every built-in adapter is held to a
single, provider-agnostic suite, and you can run that **exact same battery**
against your custom adapter by importing `runProviderContract` from the testing
entry point:

```typescript
// my-custom-adapter.contract.test.ts
import { runProviderContract } from "meridianjs/contract";
import { MyCustomAdapter } from "./my-custom-adapter.js";

runProviderContract("my-custom-provider", new MyCustomAdapter());
```

This asserts the 19 universal invariants across all eight contract dimensions:

| # | Dimension | What it checks |
|:--|:---|:---|
| 1 | **Request Metadata** | `buildRequest` returns an absolute URL, echoes the method, omits a body on GET |
| 2 | **Auth Failure** | `authStrategy({})` rejects with an `auth`-category `MeridianError` tagged with your provider name |
| 3 | **Error Mapping** | `401 → auth`, `429 → rate_limit`, `5xx → provider`; every error resolves to a canonical `MeridianErrorCode` |
| 4 | **Retry** | `retryable` stays consistent with the canonical code (`isRetryableByCode`) |
| 5 | **Rate Limit** | `rateLimitPolicy` returns numeric `limit`/`remaining` and a `reset` Date even with no headers |
| 6 | **Network Failure** | network errors map to `network` + `retryable=true` |
| 7 | **Timeout** | timeouts are `retryable` |
| 8 | **Pagination** | `paginationStrategy()` exposes all four methods and inspects a basic response without throwing |

Run the built-in adapters' contract suite anytime with:

```bash
npm run test:contracts            # all registered adapters
npm run test:contracts stripe     # focus a single provider
```

> The contract only asserts provider-agnostic invariants. Provider-specific
> details (exact auth header format, vendor rate-limit header names, status codes
> that legitimately differ such as 403/404) belong in your own `adapter.test.ts`.
