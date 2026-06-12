# Contract Registry (local)

Versioned snapshots of provider response schemas, with drift history — stored
as plain JSON under `.meridian/registry/`, committed to git, enforced in CI.
Think "lockfile for third-party API shapes".

```
.meridian/registry/
  stripe/
    v1-charges-3k2j1a/
      v1.json          # schema snapshot
      v2.json
      history.json     # append-only drift log between versions
```

## Capture

```ts
const res = await meridian.stripe.get("/v1/charges/ch_123");
await meridian.registry.snapshot("stripe", "/v1/charges", res.data);
// → v1 registered; identical schemas later are no-ops; changes write v2 + drift history
```

Or from a sample file via the CLI:

```bash
meridian registry snapshot --provider stripe --endpoint /v1/charges --data sample.json
```

## Enforce in CI

`registry check` compares a live sample against the committed snapshot and
**exits non-zero on breaking drift** (removed fields, changed types — additive
changes are warnings):

```bash
meridian registry check --provider stripe --endpoint /v1/charges --data live-sample.json
```

```yaml
# .github/workflows/api-drift.yml
name: API drift check
on:
  schedule: [{ cron: "0 6 * * *" }]
  workflow_dispatch:
jobs:
  drift:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci
      - name: Fetch a live sample
        run: |
          curl -s https://api.stripe.com/v1/charges?limit=1 \
            -u "${{ secrets.STRIPE_SECRET_KEY }}:" > live-sample.json
      - name: Check against the committed contract
        run: npx meridian registry check --provider stripe --endpoint /v1/charges --data live-sample.json
```

A breaking upstream change fails the workflow before it fails production.

## Inspect

```bash
meridian registry report --provider stripe   # versions + drift counts per endpoint
meridian registry list   --provider stripe   # tracked endpoints
```

```ts
await meridian.registry.report("stripe");
await meridian.registry.history("stripe", "/v1/charges"); // every drift event
await meridian.registry.check("stripe", "/v1/charges", liveData); // { drifts, breaking }
```

## Relationship to the schema monitor

`meridian.schema` (the drift monitor) answers "did this response drift right
now?" in-process. The registry adds the durable layer: versioned history,
git-reviewable snapshots, and a CI exit-code gate. Both share the
`.meridian/` directory and the same drift detector, so severities agree.
