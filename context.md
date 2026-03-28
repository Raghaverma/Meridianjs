# Meridian SDK: Context & Architecture

Meridian is a TypeScript-first SDK that normalizes third-party API interactions into a single, stable contract. It enforces safe defaults, resilience patterns, and consistent observability across all configured provider integrations.

## 🎯 Core Mission

In modern application development, integrating multiple third-party APIs (e.g., GitHub, Stripe, Slack) leads to fragmented codebases. Each provider has different:
- **Response Shapes**: JSON structures, envelope formats, and date representations.
- **Error Structures**: HTTP status codes vs. error codes in body, varied message formats.
- **Rate Limit Headers**: Different header names (e.g., `x-ratelimit-remaining` vs `Retry-After`).
- **Resilience Needs**: Varied retry strategies and circuit-breaking requirements.

**Meridian** solves this by providing a unified abstraction layer, ensuring your application logic interacts with a single "normalized" interface regardless of the underlying provider, and provides **Enterprise-Grade Compliance** (SOC 2, ISO 27001, HIPAA) controls natively.

---

## 🏗️ Technical Architecture

Meridian uses a pipeline-based architecture to process requests.

### 1. `Meridian` Client ([src/index.ts](file:///Users/raghavverma/Desktop/Meridian/src/index.ts))
The main entry point. It manages provider configurations, initializes adapters, and maintains global state (like circuit breaker status).
- **Initialization**: Must use `Meridian.create(config)`. Direct instantiation is prohibited to ensure async setup (like auth token discovery) completes.
- **Provider Proxy**: Dynamically exposes provider clients (e.g., `meridian.github`).

### 2. `RequestPipeline` ([src/core/pipeline.ts](file:///Users/raghavverma/Desktop/Meridian/src/core/pipeline.ts))
The execution engine for every request. It wraps the provider call in a series of layers:
1. **Sanitization**: Redacts secrets from headers and body.
2. **Idempotency**: Manages idempotency keys for unsafe operations (POST/PUT).
3. **Rate Limiting**: Enforces client-side throttling.
4. **Circuit Breaker**: Prevents cascading failures by opening the circuit on repeated upstream errors.
5. **Retry Strategy**: Handles transient failures with exponential backoff.
6. **Execution**: Uses the `ProviderAdapter` to build and send the final request.
7. **Normalization**: Converts the raw response into a `NormalizedResponse`.
- **Validation**: Includes `DriftDetector` ([src/validation/drift-detector.ts](file:///Users/raghavverma/Desktop/Meridian/src/validation/drift-detector.ts)) to catch breaking upstream API changes.

### 3. `ProviderAdapter` ([src/core/types.ts](file:///Users/raghavverma/Desktop/Meridian/src/core/types.ts))
The "contract" that bridge specific APIs to the Meridian pipeline. Every adapter must implement:
- `buildRequest`: Converts generic options to provider-specific URL/headers/body.
- `parseResponse`: Maps provider JSON/headers to `NormalizedResponse`.
- `parseError`: Maps upstream failures to `MeridianError`.
- `authStrategy`: Handles token/key retrieval.
- `rateLimitPolicy`: Extracts rate limit info from headers.
- `paginationStrategy`: Defines how to traverse paginated endpoints.

---

## 🛡️ Safety & Resilience

### Fail-Safe Defaults
- **Distributed Mode**: When `mode: "distributed"` is set, a `StateStorage` implementation (e.g., Redis) is **required**. This ensures circuit breaker and rate limiter state are shared across instances.
- **Local Unsafe**: Local development allows in-memory state, but requires explicit opt-in via `localUnsafe: true`.
- **Fail-Fast**: The SDK throws if called before `Meridian.create()` resolves.

### Secret Redaction
Meridian automatically redacts sensitive fields from all observability paths (logs, errors, metrics).
- **Sanitizers**: Located in `src/core/request-sanitizer.ts`, `error-sanitizer.ts`, and `observability-sanitizer.ts`.
- **Redacted Keys**: `authorization`, `cookie`, `token`, `apiKey`, `api_key`, `body`.

### Enterprise Compliance (SOC 2, ISO 27001, HIPAA)
Meridian provides dedicated controls for enterprise security standards:
- **Audit Logging**: Links every request to an `identity` for SOC 2 traceability.
- **PII/PHI Redaction**: Regex-based redaction for Emails, SSNs, and Credit Cards for HIPAA compliance.
- **Compliance Certification**: Documentation and technical controls to support customer audits.

---

## 🛠️ Usage & Extension

### Provider Client Methods
Each provider (e.g., `meridian.github`) exposes:
- `.get<T>(endpoint, options)`
- `.post<T>(endpoint, options)`
- `.put<T>(endpoint, options)`
- `.patch<T>(endpoint, options)`
- `.delete<T>(endpoint, options)`
- `.paginate<T>(endpoint, options)` (Async Generator)

### Adding a New Provider
1. Create a class implementing `ProviderAdapter`.
2. Map response/error shapes to Meridian types.
3. Register via `config.providers` or `meridian.registerProvider()`.

### Custom Observability
Implement the `ObservabilityAdapter` interface to pipe logs and metrics to your infrastructure. Built-in adapters include:
- **Console**: Standard logging.
- **OpenTelemetry (OTel)**: Distributed tracing and standardized metrics.
- **Prometheus**: Metrics scraping with percentile histograms.

```typescript
interface ObservabilityAdapter {
  logRequest(context: RequestContext): void;
  logResponse(context: ResponseContext): void;
  logError(context: ErrorContext): void;
  recordMetric(metric: Metric): void;
}
```

---

## 🚀 How to Run

### Development
```bash
npm install     # Install dependencies
npm run build   # Compile TypeScript to dist/
npm run test    # Run test suite (Vitest)
npm run lint    # Run Biome linting/formatting
```

### Basic Implementation
```typescript
import { Meridian } from "meridian-sdk";

const meridian = await Meridian.create({
  github: {
    auth: { token: process.env.GITHUB_TOKEN }
  },
  localUnsafe: true
});

const { data } = await meridian.github.get("/user");
```

---

## 📋 What Meridian Should Do (Guarantees)
- ✅ Never leak secrets in logs.
- ✅ Always provide a `requestId` for tracing.
- ✅ Prevent upstream overload via rate limiting.
- ✅ Protect the application from upstream downtime via circuit breaking.
- ✅ Provide a consistent `MeridianError` for handling failures.
- ✅ Support SOC 2 audit traceability via `identity` tracking.
- ✅ Automatically redact PII/PHI (HIPAA) from all observability streams.
