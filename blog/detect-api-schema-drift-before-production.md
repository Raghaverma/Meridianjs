---
title: "How to Detect API Schema Drift Before It Breaks Your Production App"
description: "API providers silently change their response shapes. Here's how to snapshot, monitor, and alert on schema drift before it reaches your users."
tags: api, typescript, reliability, monitoring, backend
date: 2026-06-05
---

# How to Detect API Schema Drift Before It Breaks Your Production App

At 2:47 AM on a Tuesday, a payment processor silently deprecated the `customer_name` field in their `/v1/customers` response. They mentioned it in a changelog entry three weeks later. In the meantime, the billing team's invoice generator had been crashing for anyone whose name exceeded 30 characters — because the fallback value was `undefined`, and `undefined.slice(0, 30)` throws.

No tests caught it. No alerts fired. A user reported it six hours later.

## Why This Is Uniquely Hard to Catch

Type errors get caught at compile time. Runtime exceptions get caught by error monitoring. But a JSON field silently disappearing from an API response hits a third category: it's syntactically valid, it passes your HTTP client, and it only fails when some downstream code path tries to access the missing property.

Your TypeScript types for third-party APIs are static. The actual API is not. When Stripe removes a field, your `StripeCustomer` type doesn't update. Your IDE won't warn you. Your CI won't fail.

The field just stops being there one day, and you find out from a bug report.

## The Manual Approach (And Why It Breaks Down)

Most teams handle this through documentation review and occasional manual spot checks:

```typescript
// v1 assumption
const name = customer.customer_name;

// v2 reality
const name = customer.name; // field was renamed — your code is now broken
```

Some teams keep versioned snapshots in fixtures:

```bash
# Save a reference response
curl https://api.stripe.com/v1/customers/cus_xxx -H "Authorization: Bearer sk_..." \
  > fixtures/stripe-customer-v1.json

# Compare later, manually
diff fixtures/stripe-customer-v1.json fixtures/stripe-customer-v2.json
```

This works until it doesn't: fixtures go stale, the diff output is unstructured, and nobody owns the process of running it consistently. It's also purely reactive — you only check when you remember to.

## Automated Drift Detection with Meridian

Install Meridian.js:

```bash
npm install meridianjs
```

The `schema` module gives you three primitives: `snapshot`, `check`, and `alert`.

**Step 1: Snapshot a known-good response.**

```typescript
import { Meridian } from "meridianjs";

const meridian = await Meridian.create({
  localUnsafe: true,
  providers: {
    stripe: { auth: { apiKey: process.env.STRIPE_SECRET_KEY } },
  },
});

const { data } = await meridian.provider("stripe")!.get("/v1/customers");

// Save this response as your baseline
await meridian.schema.snapshot("stripe", "/v1/customers", data);
```

The snapshot captures the structure — field names, types, and presence — not the values. Snapshots persist across runs so you can compare against them in future calls.

**Step 2: Check subsequent responses for drift.**

```typescript
const laterResponse = await meridian.provider("stripe")!.get("/v1/customers");

const drifts = await meridian.schema.check(
  "stripe",
  "/v1/customers",
  laterResponse.data
);

if (drifts.length > 0) {
  console.error("Schema drift detected:", drifts);
}
```

`drifts` is a typed array:

```typescript
// Example output
[
  { type: "FIELD_REMOVED", field: "customer_name", severity: "ERROR" },
  { type: "TYPE_CHANGED",  field: "metadata",      severity: "WARNING", from: "object", to: "string" },
]
```

`severity: "ERROR"` means a field consumers depend on has gone missing. `severity: "WARNING"` means something changed that may or may not break you depending on your usage.

## Setting Up a Nightly Drift Check

The real value comes from running this on a schedule, not just inline. A cron job that checks your critical endpoints every night catches drift before business hours:

```typescript
// scripts/check-drift.ts
import { Meridian } from "meridianjs";

const meridian = await Meridian.create({
  localUnsafe: true,
  providers: {
    stripe:    { auth: { apiKey: process.env.STRIPE_SECRET_KEY } },
    openai:    { auth: { apiKey: process.env.OPENAI_API_KEY } },
  },
});

const endpoints = [
  { provider: "stripe", path: "/v1/customers" },
  { provider: "stripe", path: "/v1/payment_intents" },
  { provider: "openai", path: "/v1/models" },
];

for (const { provider, path } of endpoints) {
  await meridian.schema.alert(
    provider,
    path,
    (await meridian.provider(provider)!.get(path)).data,
    (drifts, prov, endpoint) => {
      // Send to Slack, PagerDuty, whatever
      notifyTeam({
        severity: drifts.some(d => d.severity === "ERROR") ? "critical" : "warning",
        message: `Schema drift on ${prov}${endpoint}`,
        details: drifts,
      });
    }
  );
}
```

Wire this into a cron (GitHub Actions works well):

```yaml
# .github/workflows/drift-check.yml
on:
  schedule:
    - cron: "0 6 * * *"   # 6 AM UTC daily

jobs:
  drift-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npx tsx scripts/check-drift.ts
        env:
          STRIPE_SECRET_KEY: ${{ secrets.STRIPE_SECRET_KEY }}
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

Now you get a Slack message at 6 AM if any provider changed their API overnight — before your users encounter it.

## When Drift Is Detected: What to Do

An `ERROR`-severity drift requires an immediate code fix before it hits production users. Your response process should be:

1. **Pin the snapshot version.** Don't re-snapshot until your code handles the new schema. Re-snapshotting before fixing silently resets the baseline.
2. **Update your types.** Regenerate any TypeScript interfaces that reference the changed field.
3. **Deploy with a feature flag.** Roll out the schema-aware code to 5% of traffic first; verify the error rate drops to zero before full rollout.
4. **Re-snapshot after the fix.** Once your code handles the new schema correctly, update the baseline.

A `WARNING`-severity drift warrants investigation, not necessarily an emergency deploy. Check whether your code actually reads the changed field. If it doesn't, the warning is informational. If it does, treat it as an error.

The core discipline here is treating third-party API schemas the same way you treat database schema changes: versioned, tracked, and never assumed to be stable.

`npm install meridianjs` — full docs at [npmjs.com/package/meridianjs](https://www.npmjs.com/package/meridianjs).
