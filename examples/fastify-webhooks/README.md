# fastify-webhooks

Fastify server that receives and verifies Stripe webhooks using Meridian's
`WebhookVerifier` and `StripeAdapter`. Signature verification runs before any
event processing, so forged requests are rejected before they touch your business logic.

## What it demonstrates

- `WebhookVerifier.verify(adapter, payload, signature, secret)` — timing-safe HMAC check
- `StripeAdapter` imported from Meridian for signature verification
- Raw body capture in Fastify (required for HMAC integrity)
- Structured event dispatch by `event.type`
- `meridian.health()` health endpoint

## Environment variables

```
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
PORT=3002
```

## Setup

```bash
npm install meridianjs fastify
npm install -D tsx @types/node
```

Run:

```bash
npx tsx server.ts
```

## Endpoints

| Method | Path               | Description                        |
|--------|--------------------|------------------------------------|
| POST   | /webhooks/stripe   | Receive and verify Stripe events   |
| GET    | /health            | Meridian health status             |

## Testing locally

Use the Stripe CLI to forward events:

```bash
stripe listen --forward-to localhost:3002/webhooks/stripe
stripe trigger payment_intent.succeeded
```
