# Meridian Studio

A local dashboard for provider health, costs, circuit states, failovers, replay
timelines, and schema drift. Most of the data already exists inside the SDK —
Studio is a thin HTTP API over `AnalyticsCollector`, `ProviderCircuitBreaker`,
`ReliabilityStore`/`summarizeSession()`, and `ContractRegistry`, plus a separate
dashboard app that renders it.

Two pieces:

1. **The API server** — ships inside `meridianjs` (`src/studio/server.ts`). Zero
   new runtime dependencies; built on Node's `http` module.
2. **The dashboard** — a separate Next.js app, developed as its own repo (not
   published to npm, not part of the `meridianjs` package). Clone it, `npm
   install`, `npm run dev`, then point it at your API server's URL.

---

## Starting the API server

### In-process (live data)

Call this from your running app to get live health, cost, circuit-breaker, and
recording-control endpoints, in addition to disk-backed replay/schema-drift data:

```typescript
const studio = await meridian.studio({ port: 4243 });
// later: await studio.close();
```

### Standalone (disk-only)

No running app needed — useful for browsing replay sessions and schema drift
history committed to `.meridian/`:

```bash
npx meridian studio --port 4243
```

Live endpoints (`/api/health`, `/api/cost`, `/api/providers`,
`/api/circuit-breakers`, `/api/recording/*`) return `503` in this mode.

### Options (both forms)

| Option | Env var | Default | Notes |
|---|---|---|---|
| `port` | — | `4243` | |
| `host` | — | `127.0.0.1` | Binding to a non-loopback host requires `authToken` |
| `authToken` | `MERIDIAN_STUDIO_TOKEN` | unset | Required on every request via `Authorization: Bearer <token>` once set |
| `allowUnauthenticatedRemote` | — | `false` | Override the loopback-or-token requirement |
| `allowedOrigin` | — | `http://localhost:3000` | CORS origin allowed to call the API (the dashboard's URL) |
| `registryDir` | — | `.meridian/registry` | |
| `recordingsDir` | — | `.meridian/recordings` | |

The bind/auth model mirrors the [Boundary Proxy](polyglot.md): loopback
by default, and binding elsewhere without a token throws.

---

## API reference

All responses are JSON. Live endpoints 503 with an explanatory message when no
`Meridian` instance is attached.

| Method | Path | Live? | Description |
|---|---|---|---|
| GET | `/api/health` | yes | Per-provider status, success rate, latency, breaker state |
| GET | `/api/providers` | yes | Configured providers and their capabilities |
| GET | `/api/circuit-breakers` | yes | Per-provider breaker state, failures, successes, next attempt |
| GET | `/api/cost?currency=USD` | yes | Estimated spend by provider |
| GET | `/api/recording/status` | yes | Whether a reliability recording is active |
| POST | `/api/recording/start` `{ name? }` | yes | Starts a recording session |
| POST | `/api/recording/stop` `{ save?, dir? }` | yes | Stops and persists the session; returns its replay summary |
| GET | `/api/replay/sessions` | no | Lists recorded session names |
| GET | `/api/replay/sessions/:name` | no | Replay summary (requests, failovers, breaker transitions, latency) |
| GET | `/api/registry/providers` | no | Providers with at least one tracked schema |
| GET | `/api/registry/:provider` | no | Endpoint report: versions, drift counts, last capture |
| GET | `/api/registry/:provider?endpoint=<path>` | no | Drift history for one endpoint |

"No" under Live means the endpoint reads `.meridian/` directly and works the
same whether or not a `Meridian` instance is attached.

---

## Running the dashboard

The dashboard is a separate Next.js app, kept out of this repo and out of the
published package on purpose — it has its own dependencies (React, Next.js)
that the SDK shouldn't carry.

```bash
npm install
npm run dev
```

Open the app, then set the **API URL** (top right) to wherever your Studio
server is listening — the connect screen stores it (and an optional token) in
`localStorage`.

Pages: Overview (recording controls), Health, Circuit Breakers, Costs,
Failovers, Replay, Schema Drift.

---

## Known limitations

- **No live failover feed.** Failovers and breaker transitions are derived from
  a *recorded* session (`summarizeSession()`), not streamed in real time. Start
  a recording from the Overview page (or `meridian.startRecording()`) to
  capture an incident, then view it under Replay/Failovers once stopped.
- **In-process state doesn't cross processes.** `ProviderCircuitBreaker` and
  `AnalyticsCollector` live in the memory of whichever `Meridian` instance
  created them. A Studio server only sees live data if you call
  `meridian.studio()` from that same process — it cannot attach to a different
  app's in-memory state over the network.
