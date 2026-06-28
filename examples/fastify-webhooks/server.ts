import Fastify from "fastify";
import { Meridian, MeridianError, WebhookVerifier } from "meridianjs";
import { StripeAdapter } from "meridianjs/providers/payments";

const app = Fastify({ logger: true });

const PORT = Number(process.env.PORT ?? 3002);
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? "";

async function bootstrap() {
  const meridian = await Meridian.create({
    localUnsafe: true,
    providers: {
      stripe: {
        auth: { apiKey: process.env.STRIPE_SECRET_KEY ?? "" },
      },
    },
  });

  // Keep a single StripeAdapter instance for webhook verification.
  // WebhookVerifier.verify() delegates to adapter.verifyWebhook() which
  // performs a timing-safe HMAC-SHA256 check on the raw body.
  const stripeAdapter = new StripeAdapter();

  // Fastify must read the body as a raw Buffer for HMAC integrity.
  // Using addContentTypeParser lets us capture bytes before JSON parsing.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (_req, body, done) => {
      done(null, body);
    },
  );

  // POST /webhooks/stripe — verify signature then dispatch by event type
  app.post("/webhooks/stripe", async (request, reply) => {
    const rawBody = request.body as Buffer;
    const signature = (request.headers["stripe-signature"] as string) ?? "";

    // Reject requests with missing signature header before touching the body
    if (!signature) {
      return reply.status(400).send({ error: "Missing stripe-signature header" });
    }

    let verified: boolean;
    try {
      verified = WebhookVerifier.verify(stripeAdapter, rawBody, signature, STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      app.log.error({ err }, "Webhook verification threw an unexpected error");
      return reply.status(500).send({ error: "Signature verification failed" });
    }

    if (!verified) {
      app.log.warn("Stripe webhook signature mismatch — possible forged request");
      return reply.status(401).send({ error: "Invalid signature" });
    }

    let event: { type: string; id: string; data: { object: Record<string, unknown> } };
    try {
      event = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return reply.status(400).send({ error: "Invalid JSON payload" });
    }

    app.log.info({ eventType: event.type, eventId: event.id }, "Stripe webhook received");

    const obj = event.data.object;
    switch (event.type) {
      case "payment_intent.succeeded":
        app.log.info({ id: obj["id"], amount: obj["amount"] }, "Payment succeeded");
        break;
      case "payment_intent.payment_failed":
        app.log.warn({ id: obj["id"] }, "Payment failed");
        break;
      case "customer.subscription.deleted":
        app.log.info({ id: obj["id"] }, "Subscription cancelled");
        break;
      case "invoice.payment_succeeded":
        app.log.info({ id: obj["id"], amountPaid: obj["amount_paid"] }, "Invoice paid");
        break;
      default:
        app.log.info({ eventType: event.type }, "Unhandled event type");
    }

    // Acknowledge receipt immediately; Stripe retries if we return non-2xx
    return reply.status(200).send({ received: true });
  });

  // GET /health — surface Meridian's provider health as JSON
  app.get("/health", async (_request, reply) => {
    const health = meridian.health();
    const allHealthy = Object.values(health).every((h) => h.status === "healthy");
    return reply.status(allHealthy ? 200 : 503).send(health);
  });

  // Global error handler for MeridianError thrown inside route handlers
  app.setErrorHandler((err, _request, reply) => {
    if (err instanceof MeridianError) {
      const status =
        err.category === "auth" ? 401 : err.category === "rate_limit" ? 429 : 502;
      return reply.status(status).send({
        error: err.message,
        category: err.category,
        provider: err.provider,
      });
    }
    app.log.error(err);
    return reply.status(500).send({ error: "Internal server error" });
  });

  await app.listen({ port: PORT, host: "0.0.0.0" });
  console.log(`fastify-webhooks example listening on http://localhost:${PORT}`);
}

bootstrap().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
