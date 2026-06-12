# Reliability Replay

Record how the pipeline actually behaved — every outcome, retry, failover, and
circuit-breaker flip — as a named session, then replay the outage locally.

```ts
meridian.startRecording("outage-2026-06-12");

// ... traffic flows; providers fail, retries fire, breakers trip ...

const session = await meridian.stopRecording();
// → persisted to .meridian/recordings/outage-2026-06-12.json
```

Replay it any time, on any machine with the recording file:

```bash
meridian replay outage-2026-06-12
```

```
Session "outage-2026-06-12" — 42 events over 8.3s (recorded 2026-06-12T09:14:02Z)

   0.000s  openai       POST /v1/chat …
   0.412s  openai       POST /v1/chat ✗ provider: HTTP 503 (retryable)  [breaker OPEN]
   0.450s  anthropic    POST /v1/chat …
   1.002s  anthropic    POST /v1/chat → 200 (550ms, 1 retry)
   ...

Summary
  requests:  42 (38 ok / 4 failed)
  retries:   9
  failovers: 2 (openai→anthropic @0.450s, openai→anthropic @3.1s)
  breaker:   openai CLOSED→OPEN @0.412s, OPEN→HALF_OPEN @4.0s
  latency:   avg 184ms · max 1204ms
```

`meridian replay <name> --speed 10` streams the timeline at 10× the recorded
rhythm instead of rendering instantly; `meridian replay --list` shows recorded
sessions.

## Programmatic replay

```ts
const summary = await meridian.replaySession("outage-2026-06-12", {
  speed: 10,                      // omit for instant, deterministic replay
  onEvent: (e) => console.log(e), // each timeline event as it fires
  emitTo: [myObservability],      // re-emit through observability adapters —
                                  // the outage reappears on your dashboards
});

summary.failovers;          // [{ from: "openai", to: "anthropic", ... }]
summary.breakerTransitions; // [{ provider: "openai", from: "CLOSED", to: "OPEN", ... }]
summary.totalRetries;
summary.latency;            // { avgMs, maxMs }
```

## What a session contains

Pipeline *behavior*, never payloads: provider, endpoint, method, status,
duration, retry count, breaker state, error category/message. Sessions are
plain JSON under `.meridian/recordings/` — safe to commit, diff, and attach to
incident reports. (`.meridian/` is the same directory the schema monitor and
the [contract registry](registry.md) use.)

Replays never contact real providers. To re-execute a single captured request
for live debugging, the separate `meridian.debug` recorder +
`meridian.replay(requestId)` remain available.
