# Schema Drift

Detect when a provider silently changes their API response shape before it breaks your production code.

## Problem

Third-party providers rename fields, drop keys, and change types without notice. A `customer.address` that used to be a string becomes an object. A `status` field that was `"active"` becomes `"ACTIVE"`. Your code silently breaks, either writing null values to your DB or crashing at runtime — days after the provider shipped the change.

## Without Meridian

```typescript
// No detection — you find out when users report bugs
const res = await stripe.customers.retrieve(customerId);
await db.updateCustomer({
  name:    res.name,          // undefined if Stripe renamed it
  address: res.address.line1, // TypeError: can't read .line1 of string
});
```

## With Meridian

```typescript
import { Meridian } from "meridianjs";

const meridian = await Meridian.create({
  localUnsafe: true,
  providers: {
    stripe: { baseUrl: "https://api.stripe.com", auth: { type: "bearer", token: process.env.STRIPE_KEY! } },
  },
});

const { data } = await meridian.provider("stripe")!.get("/v1/customers");

// 1. Snapshot — save the current schema as your baseline
await meridian.schema.snapshot("stripe", "/v1/customers", data);

// --- later, after Stripe ships a change ---

const { data: laterData } = await meridian.provider("stripe")!.get("/v1/customers");

// 2. Check — compare live data against the baseline
const drifts = await meridian.schema.check("stripe", "/v1/customers", laterData);
// [{ field: "address", expected: "string", got: "object", severity: "breaking" }, ...]

// 3. Diff — human-readable breakdown of what changed
const diff = await meridian.schema.diff("stripe", "/v1/customers", laterData);

// 4. Report — full drift history across all snapshotted endpoints
const report = await meridian.schema.report("stripe");

// 5. Alert — fire a callback whenever drift is detected
await meridian.schema.alert("stripe", "/v1/customers", laterData, (drifts, provider, endpoint) => {
  console.error(`Schema drift on ${provider} ${endpoint}:`, drifts);
  // page on-call, write to incident log, post to Slack, etc.
});
```

## Production Example

Nightly drift check across all critical Stripe endpoints — pages on-call if breaking changes are detected:

```typescript
import { Meridian } from "meridianjs";

const meridian = await Meridian.create({
  localUnsafe: true,
  providers: {
    stripe: { baseUrl: "https://api.stripe.com", auth: { type: "bearer", token: process.env.STRIPE_KEY! } },
  },
});

const WATCHED_ENDPOINTS = [
  "/v1/customers",
  "/v1/charges",
  "/v1/payment_intents",
  "/v1/subscriptions",
];

// Run once at deploy time to seed baselines (or on first run)
export async function seedSnapshots() {
  for (const endpoint of WATCHED_ENDPOINTS) {
    const { data } = await meridian.provider("stripe")!.get(endpoint);
    await meridian.schema.snapshot("stripe", endpoint, data);
    console.log(`Snapshot saved: stripe ${endpoint}`);
  }
}

// Run nightly via cron
export async function nightly DriftCheck() {
  const results: Record<string, { drifts: unknown[]; diff: unknown }> = {};

  for (const endpoint of WATCHED_ENDPOINTS) {
    const { data } = await meridian.provider("stripe")!.get(endpoint);

    await meridian.schema.alert("stripe", endpoint, data, async (drifts, provider, ep) => {
      const breaking = (drifts as Array<{ severity: string }>).filter(d => d.severity === "breaking");

      if (breaking.length > 0) {
        // Page on-call
        await fetch(process.env.PAGERDUTY_WEBHOOK!, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            summary:  `Breaking schema drift: ${provider} ${ep}`,
            severity: "critical",
            details:  breaking,
          }),
        });
      }

      results[ep] = {
        drifts,
        diff: await meridian.schema.diff(provider, ep, data),
      };
    });
  }

  // Full report across all endpoints
  const report = await meridian.schema.report("stripe");
  console.log("Drift report:", JSON.stringify(report, null, 2));

  return results;
}
```
