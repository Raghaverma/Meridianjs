/**
 * Multi-Provider Transaction Example
 *
 * Demonstrates the saga pattern: execute a sequence of operations across
 * multiple providers. If any step fails, compensating rollbacks run
 * automatically in reverse order.
 *
 * Run: vite-node examples/transactions/index.ts
 */

import { Meridian, MeridianError, TransactionError } from "../../src/public.js";

async function main() {
  const meridian = await Meridian.create({
    localUnsafe: true,
    providers: {
      stripe: { auth: { apiKey: process.env.STRIPE_SECRET_KEY ?? "sk_test_placeholder" } },
      sendgrid: { auth: { apiKey: process.env.SENDGRID_API_KEY ?? "SG.placeholder" } },
      hubspot: { auth: { apiKey: process.env.HUBSPOT_API_KEY ?? "placeholder" } },
    },
  });

  const stripe = meridian.provider("stripe")!;
  const sendgrid = meridian.provider("sendgrid")!;
  const hubspot = meridian.provider("hubspot")!;

  console.log("--- Running 3-step transaction: charge → email → crm ---");

  try {
    const result = await meridian.transaction([
      {
        name: "charge",
        execute: async () =>
          stripe.post("/v1/charges", {
            body: {
              amount: 2000,
              currency: "usd",
              source: "tok_visa",
              description: "Example charge",
            },
          }),
        rollback: async (r) => {
          const charge = r.data as { id: string };
          console.log(`  Rolling back charge ${charge.id}`);
          await stripe.post(`/v1/charges/${charge.id}/refunds`);
        },
      },
      {
        name: "email",
        execute: async () =>
          sendgrid.post("/v3/mail/send", {
            body: {
              personalizations: [{ to: [{ email: "customer@example.com" }] }],
              from: { email: "billing@company.com" },
              subject: "Payment received",
              content: [{ type: "text/plain", value: "Thank you for your payment." }],
            },
          }),
        // No rollback — can't unsend an email; log it instead
      },
      {
        name: "crm",
        execute: async () =>
          hubspot.post("/crm/v3/objects/contacts", {
            body: { properties: { email: "customer@example.com", lifecycle_stage: "customer" } },
          }),
        rollback: async (r) => {
          const contact = r.data as { id: string };
          console.log(`  Rolling back CRM contact ${contact.id}`);
          await hubspot.delete(`/crm/v3/objects/contacts/${contact.id}`);
        },
      },
    ]);

    console.log("Transaction succeeded!");
    console.log("Steps completed:", result.succeeded);
    console.log("Results:", Object.keys(result.results));
  } catch (err) {
    if (err instanceof TransactionError) {
      console.log("\nTransaction failed at step:", err.failed);
      console.log("Steps that succeeded before failure:", err.succeeded);
      console.log("Steps rolled back:", err.rolledBack);
      if (Object.keys(err.rollbackErrors).length > 0) {
        console.log("Rollback errors (requires manual intervention):", err.rollbackErrors);
      }
    } else if (err instanceof MeridianError) {
      console.log(
        "Network/auth error (expected without real keys):",
        err.category,
        err.message.slice(0, 80),
      );
    } else {
      throw err;
    }
  }
}

main().catch(console.error);
