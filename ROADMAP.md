# Meridian Roadmap

Future direction for the Meridian SDK — covering Indian and international provider coverage, SDK-level capabilities, and compliance primitives.

---

## Execution Roadmap (v0.3 cycle) ✅ DELIVERED

The milestone was proving Meridian can act as the control plane for third-party APIs, not just an SDK with reliability features. All shipped in v0.3.0 unless noted:

1. ✅ **Adapter auto-generation** — `npx meridian add <provider>`: downloads the OpenAPI spec, generates the adapter, contract tests, pagination handler, retry classification, and normalization mappings. Generated code carries explicit `TODO(meridian-generator)` markers and a completeness score for everything inferred rather than known.
2. ✅ **OpenTelemetry auto-instrumentation** — `telemetry: { provider: "opentelemetry" }` binds the OTel observability adapter to `@opentelemetry/api` (optional peer dep) with one line; exporter recipes for Datadog, Grafana, Honeycomb, and New Relic in [docs/opentelemetry.md](docs/opentelemetry.md).
3. ✅ **Reliability replay** — named sessions persisted under `.meridian/recordings/`; `meridian replay <name>` re-renders the outage locally: retries, failovers, breaker transitions, latency spikes. See [docs/reliability-replay.md](docs/reliability-replay.md).
4. ✅ **Adaptive routing** — `strategy: "adaptive"` for services, scoring providers on success rate + latency + circuit-breaker state with explicit, configurable weights and deterministic tie-breaking. Cost/quota-aware routing deliberately deferred (see v0.4 below — partially addressed for AI calls specifically).
5. ✅ **Migration tooling** — `npx meridian migrate <provider>`: scans a codebase for direct SDK/HTTP usage and reports what maps cleanly to Meridian. Scanner only; no auto-rewrite.
6. ✅ **Local contract registry** — `meridian registry snapshot/check/report`: versioned schema snapshots with drift history under `.meridian/registry/`, committed to git, enforced in CI. See [docs/registry.md](docs/registry.md).
7. **Hosted registry** — still deferred (separate product decision).
8. **WASM policy plugins** — still parked until requested.

The shared `.meridian/` directory convention (already used by `FileSystemSchemaStorage` for schemas) extends to `recordings/` and `registry/` so replay and the registry use one on-disk layout.

---

## Execution Roadmap (v0.4 cycle) ✅ DELIVERED

The v0.3 cycle proved Meridian could generate, replay, and register contracts for itself. The v0.4 milestone was twofold: make that reliability data *visible* without a separate tool, and extend real (not just claimed) failover into the one domain where it's both possible and safe without per-provider request translation — LLM calls via the Vercel AI SDK.

1. ✅ **Meridian Studio** — local dashboard for provider health, costs, circuit states, failovers, replay timelines, and schema drift. `await meridian.studio()` (in-process, live) or `meridian studio` (CLI, disk-only). The dashboard itself ships as a separate app, not part of this package. See [docs/studio.md](docs/studio.md).
2. ✅ **`meridianjs/ai`** — Vercel AI SDK middleware (`meridianReliability()`, used with `wrapLanguageModel`). Real OpenAI↔Anthropic↔(any AI SDK provider) failover, retries, and circuit breaking — no request/response translation needed, because the AI SDK already normalizes every provider into one interface. See [docs/ai-sdk.md](docs/ai-sdk.md).
3. ✅ **`check-release-facts.mjs`** — CI-enforced consistency between the registry/test suite and every hardcoded count in README.md/SECURITY.md, so documentation can't silently drift from reality (the kind of drift that caused the v0.3.4→v0.4.0 doc audit in the first place).

---

## Current State (v0.4.0)

The adapter table below is a **historical snapshot from v0.2.3**, kept for the per-provider implementation notes further down this file. For the current, authoritative provider list, run `npm run providers:list` or see [README.md#providers](README.md#providers) — **46 adapters** as of v0.4.0.

### Built-in Adapters

| Provider | Category | Status |
|---|---|---|
| GitHub | Developer Tools | ✅ Stable |
| Anthropic | AI/LLM | ✅ Stable |
| OpenAI | AI/LLM | ✅ Stable |
| Stripe | Payments | ✅ Stable |
| Razorpay | Payments (India) | ✅ Stable |
| Cashfree | Payments (India) | ✅ Stable |
| PayU | Payments (India) | ✅ Stable |
| Juspay | Payments (India) | ✅ Stable |
| MSG91 | Communications (India) | ✅ Stable |
| Exotel | Communications (India) | ✅ Stable |
| Gupshup | Communications (India) | ✅ Stable |
| Setu | Banking/Fintech (India) | ✅ Stable |
| Decentro | Banking/Fintech (India) | ✅ Stable |
| Perfios | Financial Data (India) | ✅ Stable |
| Shiprocket | Logistics (India) | ✅ Stable |
| Delhivery | Logistics (India) | ✅ Stable |
| HyperVerge | KYC/Identity (India) | ✅ Stable |
| Digio | eSign/KYC (India) | ✅ Stable |
| Karza | KYC/Verification (India) | ✅ Stable |
| IDfy | KYC/Identity (India) | ✅ Stable |
| Cleartax | Tax/Compliance (India) | ✅ Stable |
| MapMyIndia | Maps/Geo (India) | ✅ Stable |
| Twilio | Communications (Intl) | ✅ Stable |
| SendGrid | Communications (Intl) | ✅ Stable |
| Mailgun | Communications (Intl) | ✅ Stable |
| Vonage | Communications (Intl) | ✅ Stable |
| Adyen | Payments (Intl) | ✅ Stable |
| Google Gemini | AI/LLM (Intl) | ✅ Stable |
| Auth0 | Auth/Identity (Intl) | ✅ Stable |
| HubSpot | CRM (Intl) | ✅ Stable |
| Supabase | Databases (Intl) | ✅ Stable |

> **Legend**: ✅ Adapter implemented and tested · ⚠️ Adapter implemented, contract tests pending · 📋 Planned


**Note on `verifyWebhook`**: `verifyWebhook(payload, signature, secret)` is now exposed consistently across all payment/comms adapters (Razorpay, Cashfree, PayU, Juspay, MSG91, Setu, Decentro, Shiprocket, Stripe, Exotel, Gupshup, Twilio, SendGrid, Mailgun, Vonage, Adyen) using timing-safe HMAC-SHA256. Stripe additionally accepts the `Stripe-Signature` `t=…,v1=…` header format, Twilio uses HMAC-SHA1, SendGrid uses Ed25519, Mailgun uses HMAC-SHA256 over JSON body signature object, Vonage uses HMAC-SHA256 over parameter-sorted query string, and Adyen uses HMAC-SHA256 over concatenated notification details. The API is documented in [docs/WEBHOOKS.md](docs/WEBHOOKS.md).

---

## Phase 1 — Test Coverage for All Implemented Adapters ✅ COMPLETE

All 17 Indian adapters are fully implemented, TypeScript-clean, and pass the universal provider contract suite alongside every other adapter (1489 tests across 49 test files as of v0.2.3, including 741 contract tests covering all 39 adapters). The notes below are preserved for reference when adding new adapters in this category.

### Payments (India)

**Cashfree** — Fastest growing Indian payment gateway; strong API for payouts, auto-collect, and account verification.
- Auth: `client_id` + `client_secret` (Bearer token exchange)
- Key endpoints: orders, payments, refunds, payouts, beneficiaries
- Pagination: offset-based (`page`, `limit`)
- Idempotency: `x-idempotency-key` header

**Juspay** — Dominates mobile checkout (PhonePe, Amazon Pay, Flipkart use it); critical for apps targeting Indian consumers.
- Auth: Basic auth with `merchant_id`
- Key endpoints: orders, payment methods, refunds
- Pagination: cursor-based

**PayU** — Strong in BFSI and e-commerce; supports EMI, BNPL, net banking extensively.
- Auth: `merchant_key` + HMAC-SHA512 signature per request
- Key endpoints: payment initiation, verify, refund, settlement
- Note: Signature-based auth requires per-request HMAC — adapter must implement `buildRequest` signing

### Communications (India)

**MSG91** — Market leader for OTP and transactional SMS in India.
- Auth: `authkey` header
- Key endpoints: send SMS, OTP send/verify, email, WhatsApp
- Rate limits: well-documented per-plan

**Exotel** — Cloud telephony; used by Swiggy, Ola, Zomato for call masking and IVR.
- Auth: Basic auth (`api_key:api_token`)
- Key endpoints: calls, SMS, virtual numbers

**Gupshup** — Leading WhatsApp Business API provider in India.
- Auth: `apikey` header
- Key endpoints: messages, templates, opt-in management

### Banking / Fintech (India)

**Setu** — NPCI-licensed AA (Account Aggregator) and UPI infrastructure provider.
- Auth: JWT with client credentials
- Key endpoints: AA consent flow, data fetch, UPI deep links, BillPay BBPS

**Decentro** — Core banking API aggregator; covers KYC, payments, lending, collections.
- Auth: `client_id` + `client_secret` → Bearer token
- Key endpoints: bank account verification, UPI, virtual accounts, KYC

### Logistics (India)

**Shiprocket** — Aggregates 17+ couriers; largest D2C logistics platform in India.
- Auth: email + password → JWT token (with refresh)
- Key endpoints: orders, shipments, tracking, NDR, returns

**Delhivery** — Enterprise logistics; dominates B2B and large-volume D2C.
- Auth: Bearer token
- Key endpoints: shipments, waybills, tracking, COD reconciliation

### KYC / Identity (India)

**HyperVerge** — AI-powered face match, liveness, and document OCR.
- Auth: `appId` + `appKey` headers
- Key endpoints: ID verification, face match, liveness check

**Digio** — eSign and eStamp; RBI-regulated digital signature flow.
- Auth: `client_id` + `client_secret` Basic auth
- Key endpoints: document upload, sign request, status

**Karza** — PAN, GST, Aadhaar, bank account, and business verification.
- Auth: `x-karza-key` header
- Key endpoints: PAN verify, GST details, bank account verify, ITR verify

**IDfy** — End-to-end onboarding; background checks and document verification.
- Auth: `account_id` + `api_key` Basic auth
- Key endpoints: workflows, identity checks, background verification

### Tax / Compliance (India)

**Cleartax** — GST filing, e-invoicing (IRN generation), and TDS compliance.
- Auth: Bearer token (OAuth2 client credentials)
- Key endpoints: GSTR-1, GSTR-3B, e-invoice IRN, e-way bill

### Maps / Geo (India)

**MapMyIndia (Mappls)** — India's authoritative mapping platform; OLA Maps is built on it.
- Auth: OAuth2 client credentials → Bearer token
- Key endpoints: geocode, reverse geocode, directions, places search, distance matrix

---

## Phase 2 — High-Priority New Providers

### Indian Space

#### Payments & UPI

| Provider | Why It Matters |
|---|---|
| **BillDesk** | Dominates enterprise bill payments and government collections; mandatory for BFSI |
| **CCAvenue** | 80%+ SMB market reach; required for mass-market e-commerce integrations |
| **Instamojo** | Freelancer and small business payments; strong link-based payment UX |
| **PayTM Payment Gateway** | Still significant for Tier-2/3 cities and existing PayTM user base |
| **PhonePe Business APIs** | Required for direct UPI-intent flows in consumer apps |

#### Banking & Lending

| Provider | Why It Matters |
|---|---|
| **Signzy** | KYC + bank account verification + video KYC; RBI-compliant onboarding stack |
| **Bureau.id** | Real-time fraud and risk scoring; used by fintechs for credit decisioning |
| **FinBox** | Embedded lending APIs; bank statement analysis + credit model for NBFCs |
| **Experian India** | Credit bureau; mandatory for NBFC/lending apps under RBI guidelines |
| **CRIF High Mark** | Second major credit bureau; required for comprehensive bureau pull coverage |
| **NSDL e-Gov** | PAN verification and TAN services direct from NSDL |

#### GST / Tax

| Provider | Why It Matters |
|---|---|
| **Masters India** | GST intelligence, HSN lookup, and e-invoicing; strong API with better uptime than Cleartax |
| **GSTN APIs (direct)** | Direct taxpayer APIs for GSTR fetch, GSTIN validation without intermediary |

#### Communications

| Provider | Why It Matters |
|---|---|
| **Kaleyra** | Enterprise SMS and WhatsApp; strong presence in banking notifications |
| **Netcore Cloud** | Email + SMS + push notifications; popular in e-commerce and EdTech |
| **Plivo** | Voice + SMS with Indian DLT compliance built-in |
| **ValueFirst** | SMS aggregator used by banks and insurance companies |

#### Logistics

| Provider | Why It Matters |
|---|---|
| **Bluedart (DHL)** | Premium express delivery; required for high-value and enterprise shipments |
| **Ekart (Flipkart)** | Open-network logistics for D2C brands leveraging ONDC |
| **Ecom Express** | Strong Tier-2/3 reach; popular with fashion and lifestyle D2C brands |
| **XpressBees** | High-growth logistics platform popular with quick-commerce integrations |

#### eSign / Government

| Provider | Why It Matters |
|---|---|
| **DigiLocker APIs** | Government-issued document verification (Aadhaar, driving licence, RC) |
| **UIDAI eKYC** | Aadhaar-based KYC; mandatory for regulated financial onboarding |
| **Leegality** | eSign and digital agreements; popular with LegalTech and BFSI workflows |

#### Infrastructure

| Provider | Why It Matters |
|---|---|
| **Tata Communications APIs** | Enterprise connectivity and cloud communications for large Indian enterprises |
| **OLA Maps** | Built on MapMyIndia; growing alternative with better pricing for startups |

### International Space

#### Payments

| Provider | Why It Matters |
|---|---|
| **Adyen** | Preferred gateway for Indian SaaS companies selling globally; unified commerce |
| **Braintree / PayPal** | Required for US/EU consumer-facing apps; PayPal Checkout ubiquity |
| **Checkout.com** | Strong MENA and European coverage; popular with Indian unicorn international expansions |
| **Mollie** | European payments; required for Dutch/German market penetration |
| **Klarna** | BNPL leader in Europe and US; increasingly expected in checkout flows |

#### Communications

| Provider | Why It Matters |
|---|---|
| **Twilio** | Global SMS/voice standard; used by almost every Indian startup for international users |
| **SendGrid** | Transactional email standard; high deliverability for OTP and billing emails |
| **Mailgun** | Developer-first transactional email; popular in B2B SaaS |
| **Vonage (Nexmo)** | Voice API leader; required for call center and telephony integrations |

#### AI / ML

| Provider | Why It Matters |
|---|---|
| **Cohere** | Enterprise LLM with strong RAG capabilities; growing in Indian enterprise AI adoption |
| **Mistral** | Open-weight models with EU data residency; required for European deployments |
| **HuggingFace Inference API** | Access to 100k+ models; essential for ML-heavy applications |
| **Stability AI** | Image generation APIs; used in content creation and e-commerce product imagery |
| **Google Gemini (Vertex AI)** | Strong in India via Google Cloud; required for GCP-native stacks |

#### CRM / Business Tools

| Provider | Why It Matters |
|---|---|
| **Freshworks** | Indian company (Chennai); Freshdesk + Freshsales APIs are widely used by Indian SaaS |
| **HubSpot** | CRM standard for B2B SaaS; marketing automation and contact management |
| **Salesforce** | Enterprise CRM; required for large-deal B2B integrations |
| **Zendesk** | Customer support standard; high demand from D2C and SaaS companies |

#### Auth & Identity

| Provider | Why It Matters |
|---|---|
| **Auth0 / Okta** | Identity-as-a-service standard; required when building multi-tenant SaaS |
| **Firebase Auth** | Popular for mobile apps; strong in Indian startup ecosystem |

#### Monitoring & Observability

| Provider | Why It Matters |
|---|---|
| **Sentry** | Error tracking standard; every production application needs it |
| **Datadog** | APM and infrastructure monitoring; required for enterprise deployments |
| **New Relic** | Alternative APM; strong in US enterprise market |

#### Storage & Database

| Provider | Why It Matters |
|---|---|
| **AWS S3 / CloudFront** | Object storage is a primitive for KYC document pipelines |
| **Cloudflare R2** | S3-compatible storage with no egress fees; growing in Indian startup infrastructure |
| **Supabase** | Postgres-as-a-service with storage; popular in Indian indie dev community |

---

## Phase 3 — SDK Capabilities

Beyond provider coverage, these SDK-level features have the highest return:

### Webhook Signature Verification ✅ DONE

Every payment and communication provider sends webhooks with HMAC signatures. Meridian exposes a `verifyWebhook` utility per adapter so users never re-implement HMAC-SHA256 validation. Implemented across all payment/comms adapters; see [docs/WEBHOOKS.md](docs/WEBHOOKS.md).

```typescript
// Proposed API
import { RazorpayAdapter } from "meridianjs";

const adapter = new RazorpayAdapter();
const isValid = adapter.verifyWebhook({
  payload: req.body,
  signature: req.headers["x-razorpay-signature"],
  secret: process.env.RAZORPAY_WEBHOOK_SECRET,
});
```

**Priority:** High — Razorpay, Cashfree, Stripe, MSG91, Shiprocket all use HMAC-based webhook verification.

### Streaming Response Support ✅ DONE

Implemented as an additive `stream()` method on `ProviderClient` (separate from the buffered pipeline) with a robust SSE parser (`parseSSEStream`) and an optional `parseStreamChunk` adapter hook. Handles multi-line `data:`, the `[DONE]` sentinel, and chunk-boundary splits. Used for OpenAI and Anthropic SSE streams:

```typescript
// Proposed API
for await (const chunk of meridian.provider("openai").stream("/v1/chat/completions", { ... })) {
  process.stdout.write(chunk.data.choices[0].delta.content);
}
```

### Mock / Sandbox Adapter ✅ DONE

A `MockAdapter` (exported from `meridianjs`, with `Fixtures` helpers) intercepts calls without making network requests — critical for payment and KYC adapters where sandbox environments have rate limits. Supports `onRequest`, `simulateError`, `simulateDelay`, and call recording:

```typescript
// Proposed API
import { MockAdapter } from "meridianjs/testing";

const mock = new MockAdapter("razorpay")
  .onPost("/v1/orders").reply(200, { id: "order_test_123" })
  .onGet("/v1/payments/:id").reply(200, { status: "captured" });
```

### Batch Operations ✅ DONE

Multiple Indian APIs (Razorpay, Setu, Decentro) support bulk requests. `batch()` fans out concurrently (with a configurable concurrency limit, default 10) through the same pipeline as every other client method — so retries, rate limiting, and circuit breaking all apply per-request. Failures are captured as `MeridianError` per item rather than rejecting the whole batch, enabling partial success. See [docs/batch.md](docs/batch.md).

```typescript
// Proposed API
const results = await meridian.provider("razorpay").batch([
  { method: "GET", endpoint: "/v1/payments/pay_1" },
  { method: "GET", endpoint: "/v1/payments/pay_2" },
]);
```

### India Compliance Mode (`IndiaCompliance`) ✅ DONE

DPDPA (Digital Personal Data Protection Act, 2023) requires specific PII handling. The `compliance.indiaMode` flag auto-redacts Aadhaar numbers, PAN, bank account numbers, and UPI VPAs (in addition to generic email/phone/SSN/card patterns) from all observability paths, including nested request-body values:

```typescript
// Proposed API
const meridian = await Meridian.create({
  compliance: {
    piiRedaction: true,
    indiaMode: true, // Redacts Aadhaar, PAN, UPI VPA, account numbers
  },
  ...
});
```

### UPI Flow Helpers ✅ DONE

UPI is a uniquely Indian primitive. `createUpiDeepLink` and `validateVpa` provide
provider-agnostic helpers for the two most common UPI patterns — building
`upi://pay` deep links per NPCI's spec, and validating VPA (`handle@psp`) format:

```typescript
import { createUpiDeepLink, validateVpa } from "meridianjs/upi";
// or: import { createUpiDeepLink, validateVpa } from "meridianjs";

const link = createUpiDeepLink({ vpa: "merchant@upi", amount: 1000, note: "Order #123" });
const isValid = validateVpa("user@oksbi");
```

`validateVpa` performs syntactic format validation; live VPA resolution requires
a provider call (e.g. through the Setu or Decentro adapters).

### OpenAPI Spec Generation ✅ DONE

`generateOpenApiSpec` builds an OpenAPI 3.0 document from configured providers
and the endpoints Meridian has actually observed traffic for — sourced from
`SchemaMonitor` reports (`meridian.schema.report(provider)`), which infer JSON
schemas from real response payloads. Useful for internal documentation and API
gateway configuration:

```typescript
import { generateOpenApiSpec } from "meridianjs";

const spec = generateOpenApiSpec({
  title: "My Internal API",
  providers: [
    { name: "stripe", baseUrl: "https://api.stripe.com", report: await meridian.schema.report("stripe") },
    { name: "github", baseUrl: "https://api.github.com", report: await meridian.schema.report("github") },
  ],
});
```

Each provider's endpoints are namespaced under `/{provider}/...`; since schema
snapshots record response shapes (not HTTP methods), every endpoint defaults to
`GET` — pass `methods` per provider to override specific paths.

### GraphQL Support

Low priority for v1, but increasingly needed as GitHub's v4 API, Shopify, and other providers move to GraphQL.

---

## Phase 4 — Ecosystem

- **`@meridian/react`** — React hooks (`useQuery`, `useMutation`) wrapping Meridian client methods with loading/error state
- **`@meridian/nest`** — NestJS module for injecting Meridian providers as services
- **`@meridian/next`** — Next.js API route helpers with automatic Meridian context
- **Meridian Cloud** — Hosted proxy for teams who want Meridian's normalization layer without self-hosting
- **Provider Registry** — Community-contributed adapter registry (publish adapters as npm packages following `meridian-adapter-*` convention)
- **CLI** — `npx meridian probe <provider>` to test connectivity, check rate limits, and validate credentials

---

## Contributing a New Adapter

The fastest path to adding a provider:

1. Create `src/providers/<name>/pagination.ts` — implement `PaginationStrategy`
2. Create `src/providers/<name>/adapter.ts` — implement `ProviderAdapter`
3. Create `src/providers/<name>/index.ts` — re-export both
4. Create `src/providers/<name>/adapter.test.ts` — contract tests (see `github/adapter.test.ts` as the reference)
5. Register in `src/index.ts` `BUILTIN_ADAPTER_CLASSES`
6. Export from `src/public.ts`
7. Add `provider(name: "<name>")` overload in `src/index.ts`

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full guide.

---

## Version Targets

> This table predates the v0.2–v0.4 releases and its quarter targets no longer
> line up with what actually shipped in each version — kept for historical
> context on original planning intent, not as a current schedule. For what
> actually shipped in each release, see [CHANGELOG.md](CHANGELOG.md) (current:
> v0.4.0).

| Version | Target | Focus |
|---|---|---|
| **v0.1.x** (current) | Q2 2026 | Razorpay stable; all 17 Indian adapters implemented; `verifyWebhook` on select adapters |
| **v0.2.0** | Q3 2026 | ✅ Contract tests for AI adapters (Anthropic/OpenAI/Stripe) + Twilio; ✅ `verifyWebhook` consistent across all payment/comms adapters + documented |
| **v0.3.0** | Q3 2026 | Phase 2 Indian providers (BillDesk, Signzy, Bureau.id, Freshworks); Twilio ✅ delivered early |
| **v0.4.0** | Q4 2026 | ✅ Streaming support (OpenAI/Anthropic), ✅ Mock adapter for testing — both delivered early |
| **v0.5.0** | Q4 2026 | ✅ Batch operations and India Compliance Mode (DPDPA) delivered early, UPI helpers |
| **v0.6.0** | Q1 2027 | International expansion (Adyen, Cohere, Auth0, Gemini, HubSpot, Supabase); Twilio + SendGrid + Mailgun + Vonage + Adyen + Gemini + Auth0 + HubSpot + Supabase ✅ delivered early |

| **v1.0.0** | Q2 2027 | Stable API contract, full international provider set, ecosystem packages |
