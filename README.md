# Meridian

> **⚠️ v2.0.0 establishes the safe-by-default contract. Previous versions (<2.0.0) are deprecated and contain unsafe defaults. Upgrade to >=2.0.0.**

A TypeScript SDK that normalizes third-party API interactions through a unified request pipeline, enforcing consistent error handling, rate limiting, and response shapes across providers.

## Problem Statement

Applications integrating multiple third-party APIs face inconsistent response formats, error structures, rate limit behaviors, and pagination strategies. This fragmentation requires provider-specific error handling, retry logic, and data transformation code that is difficult to maintain and test.

Meridian provides a single abstraction layer that normalizes these differences, allowing applications to interact with any provider through a consistent interface while maintaining type safety and resilience patterns.

## Non-Goals

- UI components or dashboards
- API mocking or stubbing frameworks
- Request recording or replay functionality
- GraphQL support (v1)
- Webhook handling (v1)
- Multi-region routing
- Built-in caching (applications can layer caching on top)

## Installation

```bash
npm install meridian-sdk
```

## Requirements

- **Node.js ≥18.0.0** (required for `fetch`, `Headers`, `AbortController`, `crypto.randomUUID`)

## Usage

**IMPORTANT**: Meridian requires async initialization. Always use `Meridian.create()`:

```typescript
import { Meridian } from "meridian-sdk";

// ✅ CORRECT: Async initialization
const meridian = await Meridian.create({
  github: {
    auth: { token: process.env.GITHUB_TOKEN },
  },
  localUnsafe: true, // Required for local development without StateStorage
});

const { data, meta } = await meridian.github.get("/users/octocat");
console.log(meta.rateLimit.remaining);
```

**❌ NEVER use `new Meridian()`** - the constructor is private and will fail.

### Production Deployment

For distributed deployments (serverless, multiple instances), you **must** provide a `StateStorage` implementation:

```typescript
import { Meridian } from "meridian-sdk";
import { RedisStateStorage } from "./your-redis-storage.js";

const meridian = await Meridian.create({
  mode: "distributed",
  stateStorage: new RedisStateStorage(redisClient), // Required in distributed mode
  github: {
    auth: { token: process.env.GITHUB_TOKEN },
  },
});
```

**Without `stateStorage` in distributed mode, startup will fail.** This is intentional - in-memory state cannot be shared across instances.

### Local Development

For local development, explicitly opt-in to unsafe in-memory state:

```typescript
const meridian = await Meridian.create({
  mode: "local", // or omit mode
  localUnsafe: true, // Explicitly acknowledge unsafe state
  github: {
    auth: { token: process.env.GITHUB_TOKEN },
  },
});
```

**Warning**: `localUnsafe: true` means circuit breaker and rate limiter state will be lost on process restart. This is acceptable for development but **must not be used in production**.

## Safety Guarantees

Meridian enforces safety by default:

1. **Fail-Fast Initialization**: SDK cannot be used before initialization completes. All methods throw if called before `Meridian.create()` resolves.

2. **Fail-Closed State Management**: Distributed mode requires `StateStorage`. In-memory state is opt-in only via `localUnsafe: true`.

3. **Guaranteed Secret Redaction**: All observability paths (logs, errors, metrics) automatically redact sensitive fields: `authorization`, `cookie`, `token`, `apiKey`, `api_key`, `body`.

4. **No Silent Degradation**: Runtime failures are explicit. Invalid configurations fail at startup. Adapter validation failures stop initialization.

## Public API

### Meridian Class

- `static create(config: MeridianConfig, adapters?: Map<string, ProviderAdapter>): Promise<Meridian>` - **Use this to create instances**
- `getCircuitStatus(provider: string): CircuitBreakerStatus | null`
- `registerProvider(name: string, adapter: ProviderAdapter, config: ProviderConfig): Promise<void>`

### Provider Client

Each configured provider exposes a client with:

- `get<T>(endpoint: string, options?: RequestOptions): Promise<NormalizedResponse<T>>`
- `post<T>(endpoint: string, options?: RequestOptions): Promise<NormalizedResponse<T>>`
- `put<T>(endpoint: string, options?: RequestOptions): Promise<NormalizedResponse<T>>`
- `patch<T>(endpoint: string, options?: RequestOptions): Promise<NormalizedResponse<T>>`
- `delete<T>(endpoint: string, options?: RequestOptions): Promise<NormalizedResponse<T>>`
- `paginate<T>(endpoint: string, options?: RequestOptions): AsyncGenerator<NormalizedResponse<T>>`

## Project Status

**v2.0.0** - Production-ready safety contract established. Core functionality is stable. Provider coverage is expanding. API stability guaranteed for 2.x releases.

## License

MIT. See [LICENSE.md](LICENSE.md) for details.
