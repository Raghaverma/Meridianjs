# Policy Engine — Internals

How policies fit into the request pipeline, when they run, and what they can do.

---

## Where policies run

Policies are evaluated inside `RequestPipeline.execute()`, **before** the rate limiter, circuit breaker, and network call. This is intentional: a blocked request should not consume rate-limit tokens, increment circuit-breaker failure counts, or touch the network at all.

```
execute()
  │
  ├─ 1. Policy evaluation        ← policies[].evaluate(ctx)  [blocks here]
  │
  ├─ 2. Rate limiter             rateLimiter.acquire()
  │
  ├─ 3. Retry loop
  │     └─ 4. Circuit breaker    circuitBreaker.execute()
  │           └─ 5. HTTP call    fetch(builtRequest.url, …)
  │
  ├─ 6. Normalize response
  └─ 7. Analytics + observability
```

If any policy returns `{ allow: false }`, `execute()` throws a `MeridianError` with category `"validation"` immediately. No rate-limit token is spent, no circuit-breaker state changes, no network call is made.

---

## Policy evaluation loop

```typescript
for (const policy of this.config.policies) {
  const decision = policy.evaluate(ctx);

  if (!decision.allow) {
    throw new MeridianError(
      `Policy "${policy.name}" blocked request: ${decision.reason}`,
      "validation",
      this.config.provider,
      false,          // retryable: false — a blocked policy is never retried
      requestId,
    );
  }

  if (decision.transform !== undefined) {
    const patch = decision.transform(ctx);
    // patch is applied to options AND to ctx, so later policies
    // see the already-transformed request
    if (patch.body    !== undefined) { options.body    = patch.body;    ctx.body    = patch.body; }
    if (patch.query   !== undefined) { options.query   = patch.query;   ctx.query   = patch.query; }
    if (patch.headers !== undefined) { options.headers = patch.headers; ctx.headers = patch.headers; }
  }
}
```

Key properties:
- **Sequential** — policies run in the order they are declared; the first `allow: false` wins.
- **Context mutation** — a transforming policy mutates `ctx` in-place, so subsequent policies see the transformed values (e.g. a `redact` policy that removes PII fields runs before a `blockPII` policy that would have detected them).
- **Short-circuit** — evaluation stops at the first denial; later policies are not evaluated.

---

## The `PolicyContext` object

```typescript
interface PolicyContext {
  provider: string;        // e.g. "openai"
  endpoint: string;        // e.g. "/v1/chat/completions"
  method:   string;        // "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
  body?:    unknown;       // request body (mutated by transform policies)
  headers?: Record<string, string>;
  query?:   Record<string, string | number | boolean>;
}
```

`provider` and `endpoint` are always set. `body`, `headers`, and `query` are only present when the request includes them — check before reading.

---

## The two decision shapes

```typescript
type PolicyDecision =
  | { allow: false; reason: string }
  | { allow: true;  transform?: (ctx: PolicyContext) => Partial<Pick<PolicyContext, "body" | "query" | "headers">> };
```

A policy that allows without transforming returns `{ allow: true }`. A policy that transforms returns `{ allow: true, transform: (ctx) => ({ body: sanitized }) }` — the pipeline calls `transform` and merges the patch. A policy that blocks returns `{ allow: false, reason: "..." }`.

---

## Ordering recommendations

Declare policies in this order to get correct behaviour at minimum cost:

1. **Allowlist / provider whitelist** — fast structural check, no body inspection needed
2. **Method guards** (`readOnly`) — fast, no body inspection
3. **Redact** — strip fields before any detection policy sees them
4. **PII detection** (`blockPII`) — body inspection; runs after redaction so already-scrubbed fields don't trigger false positives
5. **Field requirements** (`requireFields`) — validates body shape
6. **Geo / country restrictions** — typically a header or body field check
7. **Custom business logic** — everything else

```typescript
policies: [
  allowedProviders(["openai", "stripe"]),         // 1. structural
  readOnly(["github"]),                           // 2. method guard
  redact(["card.number", "user.ssn"]),            // 3. redact first
  blockPII(["openai", "anthropic"]),              // 4. then detect
  requireFields(["tenantId"]),                    // 5. validate shape
  denyCountries(["KP", "IR"]),                   // 6. geo
  customPolicy("consent", (ctx) => { … }),        // 7. custom
]
```

---

## Transform policy semantics

The patch returned by `transform` is **merged**, not replaced. To unset a field you must explicitly set it to `undefined` or return a modified copy. The pipeline merges with `Object.assign(options, updated)` where `updated` spreads `options` and overlays the patch — so unpatched fields are preserved.

Example — redacting a nested field:

```typescript
customPolicy("redact-ssn", (ctx) => ({
  allow: true,
  transform: () => ({
    body: {
      ...(ctx.body as object),
      user: {
        ...(ctx.body as { user?: object })?.user,
        ssn: "[REDACTED]",
      },
    },
  }),
}))
```

---

## Policies and `ServiceClient`

Policies are declared on the `Meridian` instance and passed to each `RequestPipeline` at creation time. When `ServiceClient` routes to a provider, it calls that provider's `RequestPipeline.execute()`, which runs the full policy set. Policies therefore apply to **all providers in a service**, not just the one that ultimately handles the request.

If you need provider-specific policies, use `customPolicy` with a check on `ctx.provider`:

```typescript
customPolicy("openai-consent", (ctx) => {
  if (ctx.provider !== "openai") return { allow: true };
  const body = ctx.body as Record<string, unknown>;
  return body.consentGiven === true
    ? { allow: true }
    : { allow: false, reason: "OpenAI calls require consentGiven: true" };
})
```

---

## Built-in policy implementations

| Policy | What it checks | Blocks or transforms |
|---|---|---|
| `blockPII` | regex scan of serialised body for credit cards, SSNs, emails, Aadhaar, PAN | blocks |
| `redact` | dot-path field list in body | transforms (sets to `"[REDACTED]"`) |
| `requireFields` | dot-path field list in body | blocks if any missing |
| `denyCountries` | `ctx.query.country` or `ctx.body.country` ISO 3166-1 alpha-2 | blocks |
| `allowedProviders` | `ctx.provider` | blocks |
| `blockedProviders` | `ctx.provider` | blocks |
| `readOnly` | `ctx.method` ∈ `{POST,PUT,PATCH,DELETE}` for listed providers | blocks |
| `customPolicy` | user-supplied function | blocks or transforms |

---

## Error produced on block

```typescript
new MeridianError(
  `Policy "${name}" blocked request: ${reason}`,
  "validation",   // category — not retried, not counted as provider failure
  provider,
  false,          // retryable: false
  requestId,
)
```

The `"validation"` category means the retry strategy will not retry a blocked request, and the circuit breaker will not count it as a provider failure. Blocked requests do appear in the observability `logError` call and in analytics `errorRate`.

---

## See also

- [Policies how-to](policies/index.md) — configuration reference and production examples
- [RequestPipeline source](../src/core/pipeline.ts) — evaluation loop at line 135
- [Built-in policies source](../src/orchestration/policies/index.ts)
