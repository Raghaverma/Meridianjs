# Doctor

`meridian doctor` is a read-only health check. It reads what already lives on
disk inside `.meridian/` — the [contract registry](registry.md) and
[reliability recordings](reliability-replay.md) — plus the runtime environment,
and turns it into a single, severity-ranked list of findings.

No network calls, no API keys, no running app. Same disk-only contract as
`meridian studio`: point it at a checkout (or a CI artifact) and it tells you
what's unhealthy.

```bash
meridian doctor
```

```
Meridian doctor — 2026-06-23T14:47:05.208Z

Environment
  ✓ Node 20.11.0 · Meridian v0.4.0
  ✓ AI SDK reliability middleware (meridianjs/ai) ready
  ✓ gRPC Boundary Proxy (polyglot clients) ready
  ✓ OpenTelemetry auto-instrumentation ready

Contract registry
  ⚠ openai /v1/models: 1 breaking schema change(s) recorded
      2 drift event(s) total, now at v3.
      → Review the history with `meridian registry report --provider openai`.

Reliability recordings
  ⚠ "outage": circuit breaker opened for openai
      1 OPEN transition(s) — the provider failed enough to be shed.
  ⚠ "outage": 67% of requests failed
      2/3 requests errored.
  · "outage": 1 failover(s) (openai→anthropic)
      Failover engaged — the recovery path was exercised.
  ✓ 1 recording(s) analyzed

✗ Action required — 0 critical · 3 warning · 1 info
```

## What it checks

**Environment** — Node is at or above the supported floor (20+), and which
optional integrations are installed (the AI SDK middleware, the gRPC proxy, and
OpenTelemetry are optional peer dependencies).

**Contract registry** — for every tracked endpoint: breaking schema changes in
its drift history, non-breaking drift, and schemas that haven't been
re-verified against a live sample in over 90 days.

**Reliability recordings** — for every recorded session: circuit breakers that
reached `OPEN`, sessions where most requests failed, retry storms, latency
spikes, and failovers that engaged. (Failovers are reported as info — a
recovery path firing is the system working.)

Findings are ranked most-severe-first: **critical** (the runtime can't be
trusted to work), **warning** (an actionable reliability concern),
**info** (context), **ok** (a check that passed).

## Flags

| Flag | Effect |
|---|---|
| `--json` | Emit the full report as JSON instead of the formatted audit. |
| `--strict` | Exit non-zero on warnings too, not just critical findings. |
| `--registry-dir <dir>` | Registry location (default `.meridian/registry`). |
| `--recordings-dir <dir>` | Recordings location (default `.meridian/recordings`). |

## Exit codes

`0` when there are no critical findings, `1` otherwise. With `--strict`, any
warning also exits `1` — drop `meridian doctor --strict` into CI to fail a
build when a tracked contract has broken or a committed recording shows a
provider melting down.

```bash
# CI gate: fail if anything in .meridian/ looks unhealthy
meridian doctor --strict
```

The `--json` shape is stable for tooling:

```jsonc
{
  "generatedAt": "2026-06-23T14:47:05.208Z",
  "findings": [
    { "severity": "warning", "area": "recordings", "title": "...", "detail": "...", "remedy": "..." }
  ],
  "counts": { "critical": 0, "warning": 3, "info": 1, "ok": 5 },
  "healthy": true
}
```
