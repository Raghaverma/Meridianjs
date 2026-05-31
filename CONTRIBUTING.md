# Contributing to Meridian

## Setup

1. Fork the repository
2. Clone your fork: `git clone https://github.com/your-username/Meridian.git`
3. Install dependencies: `npm install`
4. Build the project: `npm run build`
5. Run tests: `npm test`

## Building a New Adapter

The fastest way to contribute is to implement one of the 17+ registered-but-not-yet-built providers. See [ROADMAP.md](ROADMAP.md) for the full list and per-provider notes on auth patterns, pagination, and key endpoints.

### Step-by-step

1. **Create `src/providers/<name>/pagination.ts`**

   Implement `PaginationStrategy`. Use `StripePaginationStrategy` (cursor-based) or `RazorpayPaginationStrategy` (offset-based) as references depending on what the provider uses.

2. **Create `src/providers/<name>/adapter.ts`**

   Implement `ProviderAdapter`. Every adapter must implement:
   - `buildRequest` — construct URL, headers (auth), body, query params
   - `parseResponse` — delegate to `ResponseNormalizer.normalize`
   - `parseError` — map HTTP status codes to the five canonical categories: `auth`, `rate_limit`, `network`, `validation`, `provider`
   - `authStrategy` — validate and return `AuthToken` from `AuthConfig`
   - `rateLimitPolicy` — parse rate limit headers or return sensible defaults
   - `paginationStrategy` — return your pagination strategy instance
   - `getIdempotencyConfig` — declare which operations support idempotency keys

   Use `src/providers/stripe/adapter.ts` (payment provider) or `src/providers/github/adapter.ts` (token auth) as templates.

3. **Create `src/providers/<name>/index.ts`**

   ```typescript
   export * from "./adapter.js";
   export * from "./pagination.js";
   ```

4. **Create `src/providers/<name>/adapter.test.ts`**

   Follow `src/providers/github/adapter.test.ts` exactly. Required test coverage:
   - `buildRequest`: auth header, query params, JSON body, idempotency key, no body on GET
   - `parseResponse`: normalized shape, pagination extraction
   - `parseError`: all canonical status codes (401, 403, 404, 400, 422, 429, 500, 5xx, network error)
   - `rateLimitPolicy`: present headers, missing headers fallback
   - `authStrategy`: valid credentials, missing credentials (must throw `MeridianError` with `category: "auth"`)
   - `paginationStrategy`: cursor extraction, `buildNextRequest`
   - `getIdempotencyConfig`: safe methods, write operation overrides

5. **Register in `src/index.ts`**

   Add to `BUILTIN_ADAPTER_CLASSES` and add a `provider(name: "<name>")` overload.

6. **Export from `src/public.ts`**

   ```typescript
   export { YourAdapter } from "./providers/your-provider/adapter.js";
   ```

7. **Update `CHANGELOG.md`** under `[Unreleased]`.

### Error mapping rules

All adapters must map errors to exactly these five categories — never expose provider-specific error shapes on the `MeridianError` object:

| HTTP Status | Category | Retryable |
|---|---|---|
| 401 | `auth` | false |
| 403 | `auth` (or `rate_limit` if rate-limit headers present) | false (true if rate_limit) |
| 404 | `validation` | false |
| 400, 409, 422 | `validation` | false |
| 429 | `rate_limit` | true |
| 5xx | `provider` | true |
| Network/fetch error | `network` | true |

### Checklist before submitting

- [ ] `npm run typecheck` passes with zero errors
- [ ] `npm test` passes (all existing + new tests)
- [ ] Error categories match the mapping table above
- [ ] `MeridianError.provider` is set to the provider name string
- [ ] No raw provider error fields leak onto the `MeridianError` object
- [ ] `parseError` handles both `Error` instances (network) and HTTP error objects
- [ ] Auth failure throws `MeridianError` with `category: "auth"`, not a plain `Error`

## Branching

- `main`: Production-ready code
- `develop`: Integration branch for features
- Feature branches: `feature/description`
- Bug fixes: `fix/description`
- Documentation: `docs/description`

Create feature branches from `develop`. Submit pull requests targeting `develop`.

## Commit Messages

Follow conventional commits:

- `feat: add Stripe provider adapter`
- `fix: correct rate limit header parsing`
- `docs: update API documentation`
- `test: add circuit breaker state transition tests`
- `refactor: simplify pagination strategy interface`

Scope is optional but recommended: `feat(github): add OAuth2 support`

## Testing

All new code must include tests:

- Unit tests for isolated components
- Integration tests for provider adapters
- Edge case coverage for resilience patterns

Run `npm test` before submitting. Ensure all tests pass and coverage does not decrease.

## Pull Request Process

1. Update CHANGELOG.md with your changes
2. Ensure all tests pass
3. Update documentation if API changes
4. Request review from maintainers
5. Address feedback and maintain discussion thread

PRs are merged after:
- At least one maintainer approval
- All CI checks passing
- No merge conflicts
- Documentation updated if needed

## Code Style

- TypeScript strict mode
- Biome for formatting and linting
- No `any` types in public API
- Prefer explicit types over inference in public interfaces

Run `npm run lint` before committing.


