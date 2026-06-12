# OpenTelemetry

Meridian instruments every request with spans, metrics, and errors through
[`@opentelemetry/api`](https://www.npmjs.com/package/@opentelemetry/api) — one
config line, no per-provider work:

```ts
const meridian = await Meridian.create({
  telemetry: { provider: "opentelemetry" },
  providers: { stripe: { auth: { apiKey: process.env.STRIPE_KEY! } } },
  // ...
});
```

Or, if the OTel SDK is registered after Meridian is created:

```ts
await meridian.instrumentOpenTelemetry();
```

`@opentelemetry/api` is an **optional peer dependency** — install it alongside
whichever OTel SDK/exporter your platform uses:

```bash
npm install @opentelemetry/api @opentelemetry/sdk-node @opentelemetry/exporter-trace-otlp-http
```

## What gets emitted

Per request:

| Signal | Name | Detail |
|---|---|---|
| Span | `<provider>.<METHOD>` | attributes: `meridian.provider`, `http.method`, `http.url`, `http.status_code`, `meridian.request_id`, `meridian.duration_ms`; errors set span status + `recordException` with `meridian.error.category` / `meridian.error.retryable` |
| Counter | `meridian.requests` | tags: `provider`, `method` |
| Counter | `meridian.errors` | tags: `provider`, `category` |
| Histogram | `meridian.duration` (ms) | tags: `provider`, `method`, `status` |
| Counters | `meridian.request.count` / `meridian.request.duration` / `meridian.request.error` | the pipeline's internal metric channel, one counter per metric name |

Options:

```ts
telemetry: {
  provider: "opentelemetry",
  name: "my-service",        // instrumentation scope (default "meridianjs")
  metricPrefix: "myapp",     // metric name prefix (default "meridian")
}
```

## Exporter recipes

Meridian binds to the *globally registered* OTel SDK, so wiring a backend is
the standard OTel setup for your platform — register the SDK once, before
`Meridian.create`.

### OTLP (Grafana, Honeycomb, and any OTLP-native backend)

```ts
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";

const sdk = new NodeSDK({
  serviceName: "checkout-service",
  traceExporter: new OTLPTraceExporter({
    url: "https://otlp-gateway-prod-us-central-0.grafana.net/otlp/v1/traces", // Grafana Cloud
    // url: "https://api.honeycomb.io/v1/traces",                             // Honeycomb
    headers: {
      /* Grafana: Authorization: Basic <instanceId:token> · Honeycomb: "x-honeycomb-team": KEY */
    },
  }),
  metricReader: new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({ /* same endpoint family, /v1/metrics */ }),
  }),
});
sdk.start();

const meridian = await Meridian.create({
  telemetry: { provider: "opentelemetry" },
  /* ... */
});
```

### Datadog

Datadog ingests OTLP through the Datadog Agent (enable `otlp_config` in the
agent, default port 4318), so the OTLP recipe above pointed at the agent works
unchanged:

```ts
new OTLPTraceExporter({ url: "http://localhost:4318/v1/traces" })
```

Alternatively `dd-trace` ships an OTel API bridge (`tracer.init()` registers
itself as the global provider) — Meridian picks it up automatically.

### New Relic

New Relic is OTLP-native:

```ts
new OTLPTraceExporter({
  url: "https://otlp.nr-data.net/v1/traces",
  headers: { "api-key": process.env.NEW_RELIC_LICENSE_KEY! },
})
```

## Notes

- Without a registered SDK, `@opentelemetry/api` falls back to its built-in
  no-op implementation — Meridian keeps working, signals go nowhere.
- Meridian's own `ConsoleObservability`/`PrometheusObservability` adapters can
  run alongside OTel; `telemetry` appends, it doesn't replace `observability`.
- Span attribute redaction follows the same `observabilitySanitizer` config as
  every other observability adapter.
