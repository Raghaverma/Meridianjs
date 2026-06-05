# Transactions

Coordinate multi-step API flows with automatic compensating rollbacks when any step fails.

## Problem

Real workflows span multiple providers: charge a card, send a welcome email, provision a GitHub repo. If step 3 fails, you've already taken money and sent an email — the user is stuck in a half-created state. Without a saga pattern, you're either writing rollback logic by hand for every flow or ignoring the problem until support tickets arrive.

## Without Meridian

```typescript
// Manual rollback — error-prone, not composable
async function signupUser(email: string, plan: string) {
  let chargeId: string | null = null;

  try {
    const charge = await stripe.paymentIntents.create({ amount: 2900, currency: "usd" });
    chargeId = charge.id;

    await sendgrid.mail.send({ to: email, subject: "Welcome!", text: "You're in." });

    await octokit.repos.createForAuthenticatedUser({ name: `${email}-workspace`, private: true });
  } catch (err) {
    // If GitHub failed, we need to refund Stripe — but only if we already charged
    if (chargeId) {
      await stripe.refunds.create({ payment_intent: chargeId }).catch(() => {
        console.error("Refund also failed — now what?");
      });
    }
    // What about the email that already went out? No rollback for that.
    throw err;
  }
}
```

## With Meridian

```typescript
import { Meridian } from "meridianjs";

const meridian = await Meridian.create({
  localUnsafe: true,
  providers: {
    stripe:   { baseUrl: "https://api.stripe.com",   auth: { type: "bearer", token: process.env.STRIPE_KEY! } },
    sendgrid: { baseUrl: "https://api.sendgrid.com", auth: { type: "bearer", token: process.env.SENDGRID_KEY! } },
    github:   { baseUrl: "https://api.github.com",   auth: { type: "bearer", token: process.env.GITHUB_TOKEN! } },
  },
});

await meridian.transaction([
  {
    name: "charge",
    execute: () =>
      meridian.provider("stripe")!.post("/v1/payment_intents", {
        body: { amount: 2900, currency: "usd", confirm: true },
      }),
    rollback: (result) =>
      meridian.provider("stripe")!.post(`/v1/refunds`, {
        body: { payment_intent: result.data.id },
      }),
  },
  {
    name: "email",
    execute: () =>
      meridian.provider("sendgrid")!.post("/v3/mail/send", {
        body: { to: [{ email: "user@example.com" }], subject: "Welcome!", content: [{ type: "text/plain", value: "You're in." }] },
      }),
    // No rollback for email — Meridian skips steps with no rollback defined
  },
  {
    name: "repo",
    execute: () =>
      meridian.provider("github")!.post("/user/repos", {
        body: { name: "user-workspace", private: true },
      }),
    rollback: (result) =>
      meridian.provider("github")!.delete(`/repos/org/${result.data.name}`),
  },
]);
// If "repo" throws, Meridian runs rollback("charge") and rollback("email" if defined) in reverse order.
```

## Production Example

SaaS subscription signup with full rollback chain — Stripe refund and GitHub repo deletion if any step fails:

```typescript
import { Meridian } from "meridianjs";

const meridian = await Meridian.create({
  localUnsafe: true,
  providers: {
    stripe:   { baseUrl: "https://api.stripe.com",   auth: { type: "bearer", token: process.env.STRIPE_KEY! },   retry: { attempts: 2 } },
    sendgrid: { baseUrl: "https://api.sendgrid.com", auth: { type: "bearer", token: process.env.SENDGRID_KEY! }, retry: { attempts: 3 } },
    github:   { baseUrl: "https://api.github.com",   auth: { type: "bearer", token: process.env.GITHUB_TOKEN! }, retry: { attempts: 2 } },
  },
});

interface SignupParams {
  email:          string;
  paymentMethod:  string;
  orgName:        string;
  plan:           "starter" | "pro" | "enterprise";
}

export async function provisionSubscription({ email, paymentMethod, orgName, plan }: SignupParams) {
  const amounts: Record<string, number> = { starter: 1900, pro: 4900, enterprise: 19900 };

  await meridian.transaction([
    {
      name: "charge",
      execute: () => meridian.provider("stripe")!.post("/v1/payment_intents", {
        body: { amount: amounts[plan], currency: "usd", payment_method: paymentMethod, confirm: true },
      }),
      rollback: (result) => {
        console.warn(`[rollback] Refunding ${result.data.id}`);
        return meridian.provider("stripe")!.post("/v1/refunds", { body: { payment_intent: result.data.id } });
      },
    },
    {
      name: "welcome-email",
      execute: () => meridian.provider("sendgrid")!.post("/v3/mail/send", {
        body: { to: [{ email }], from: { email: "noreply@yourapp.com" }, subject: `Welcome to ${plan}`,
                content: [{ type: "text/plain", value: `Your ${plan} workspace is provisioning.` }] },
      }),
      // No rollback — email can't be unsent; Meridian notes this and continues unwinding.
    },
    {
      name: "github-repo",
      execute: () => meridian.provider("github")!.post("/orgs/your-org/repos", {
        body: { name: `${orgName}-workspace`, private: true, auto_init: true },
      }),
      rollback: (result) => {
        console.warn(`[rollback] Deleting repo ${result.data.full_name}`);
        return meridian.provider("github")!.delete(`/repos/${result.data.full_name}`);
      },
    },
  ]);

  console.log(`Provisioned ${plan} for ${email}`);
}
```
