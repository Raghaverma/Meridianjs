# Webhook Signature Verification

Meridian provides a consistent `verifyWebhook` method across all supported payment and communication adapters. Every implementation is timing-safe (uses `crypto.timingSafeEqual` internally) and returns `false` on any error rather than throwing.

## Contract

```ts
verifyWebhook(payload: string | Buffer, signature: string, secret: string): boolean
```

| Parameter   | Description |
|-------------|-------------|
| `payload`   | The **raw request body** — must be the original string or Buffer, NOT parsed JSON. Parsing before verification will break the HMAC check. |
| `signature` | The signature value from the webhook header (e.g. `X-Razorpay-Signature`, `Stripe-Signature`). |
| `secret`    | The webhook secret configured in the provider dashboard. |

Returns `true` when the signature is valid, `false` otherwise. Never throws.

## Supported Adapters

| Adapter      | Provider        | Signature Scheme |
|--------------|-----------------|------------------|
| `razorpay`   | Razorpay        | HMAC-SHA256 hex over raw payload |
| `cashfree`   | Cashfree        | HMAC-SHA256 hex over raw payload |
| `payu`       | PayU            | HMAC-SHA256 hex over raw payload |
| `juspay`     | Juspay          | HMAC-SHA256 hex over raw payload |
| `setu`       | Setu            | HMAC-SHA256 hex over raw payload |
| `decentro`   | Decentro        | HMAC-SHA256 hex over raw payload |
| `shiprocket` | Shiprocket      | HMAC-SHA256 hex over raw payload |
| `msg91`      | MSG91           | HMAC-SHA256 hex over raw payload |
| `stripe`     | Stripe          | HMAC-SHA256 hex over raw payload; additionally supports the `Stripe-Signature` header format (`t=<timestamp>,v1=<hex>`) where the signed payload is `"${timestamp}.${rawBody}"` |
| `exotel`     | Exotel          | HMAC-SHA256 hex over raw payload |
| `gupshup`    | Gupshup         | HMAC-SHA256 hex over raw payload |
| `sendgrid`   | SendGrid        | Ed25519 signature over payload (typically `timestamp + rawBody`); signature is base64-encoded in `X-Twilio-Email-Event-Webhook-Signature` header, public key is base64-encoded |
| `mailgun`    | Mailgun         | HMAC-SHA256 hex over concatenated payload (`timestamp + token`) from the JSON body |
| `vonage`     | Vonage          | HMAC-SHA256 hex over parameter-sorted query string |
| `adyen`      | Adyen           | HMAC-SHA256 base64 over concatenated payment details string |

## Usage

### Via `WebhookVerifier.verify` (recommended)

`WebhookVerifier.verify` delegates to the adapter's `verifyWebhook` and throws a clear error if the adapter does not support webhook verification.

```ts
import { WebhookVerifier, RazorpayAdapter } from "meridianjs";

const adapter = new RazorpayAdapter();

// req.body must be the raw Buffer/string — do NOT call JSON.parse first
const isValid = WebhookVerifier.verify(
  adapter,
  req.rawBody,           // string | Buffer
  req.headers["x-razorpay-signature"],
  process.env.RAZORPAY_WEBHOOK_SECRET
);

if (!isValid) {
  return res.status(400).send("Invalid webhook signature");
}
```

### Directly on the adapter

```ts
import { StripeAdapter } from "meridianjs";

const adapter = new StripeAdapter();

// Stripe sends the Stripe-Signature header in "t=<ts>,v1=<hex>" format
const isValid = adapter.verifyWebhook(
  req.rawBody,                         // raw Buffer or string
  req.headers["stripe-signature"],     // "t=1700000000,v1=abc123..."
  process.env.STRIPE_WEBHOOK_SECRET
);
```

### Stripe — raw hex signature (alternative)

If you have extracted the bare hex signature yourself, you can pass it directly:

```ts
const isValid = adapter.verifyWebhook(
  req.rawBody,
  "abc123def456...",                   // bare HMAC-SHA256 hex
  process.env.STRIPE_WEBHOOK_SECRET
);
```

## Important: Use the Raw Body

The HMAC is computed over the exact bytes Stripe (or any other provider) sent. If you parse the body with `JSON.parse` and then `JSON.stringify` it before verification, whitespace differences will cause the check to fail.

**Express example — capture raw body:**

```ts
app.use(
  express.raw({ type: "application/json" })  // keeps req.body as Buffer
);

app.post("/webhooks/stripe", (req, res) => {
  const isValid = adapter.verifyWebhook(
    req.body,                               // Buffer — raw bytes
    req.headers["stripe-signature"] as string,
    process.env.STRIPE_WEBHOOK_SECRET!
  );

  if (!isValid) return res.sendStatus(400);

  const event = JSON.parse(req.body.toString());
  // handle event ...
  res.sendStatus(200);
});
```

## Timestamp Freshness (Replay Protection)

Stripe webhooks include a signed timestamp (`t=<unix_seconds>` in the `Stripe-Signature` header). Meridian's verifier automatically rejects webhooks older than 300 seconds (5 minutes) to prevent replay attacks — a single captured webhook cannot be replayed indefinitely.

This tolerance is the optional 4th positional argument to `verifyWebhook`, in **seconds**:

```ts
// Default: reject events older than 300 seconds
const isValid = adapter.verifyWebhook(req.body, signature, secret);

// Custom tolerance (in seconds)
const isValid = adapter.verifyWebhook(req.body, signature, secret, 60); // 1 minute

// Opt-out of timestamp checks (not recommended for production)
const isValid = adapter.verifyWebhook(req.body, signature, secret, Infinity);
```

Always keep the default 300-second tolerance in production to protect against captured webhooks being replayed to drive duplicate fulfillment.
