/**
 * demo:schema-drift
 *
 * Scenario: Stripe silently removes a field from `/v1/customers/:id`
 * responses — no changelog, no deprecation notice, just a smaller JSON body
 * on the next deploy. Meridian snapshots response shapes and flags the
 * change before it reaches production.
 *
 * Run: npm run demo:schema-drift
 */

import { Meridian } from "../src/index.js";
import { NoOpObservability } from "../src/infrastructure/observability/noop.js";
import { InMemorySchemaStorage } from "../src/infrastructure/validation/schema-storage.js";
import { MockAdapter } from "../src/testing/mock-adapter.js";
import { banner, color, section, sleep } from "./_shared.js";

async function main() {
  const provider = "stripe";
  const endpoint = "/v1/customers/cus_123";

  banner("Meridian Schema Drift Demo");
  console.log("Scenario: Stripe silently removes `customer_name` from a customer response.\n");

  // A live provider keeps Meridian.create happy; drift detection is independent of it.
  const meridian = await Meridian.create({
    localUnsafe: true,
    observability: new NoOpObservability(),
    schemaValidation: { enabled: true, storage: new InMemorySchemaStorage() },
    providers: {
      stripe: { auth: {}, adapter: new MockAdapter("stripe") },
    },
  });

  const today = { id: "cus_123", customer_name: "Acme Corp", amount: 4200 };
  const afterDeploy = { id: "cus_123", amount: 4200 };

  section(`Step 1 — snapshot today's response from ${provider}${endpoint}`);
  console.log(`  ${color.dim(JSON.stringify(today))}`);
  await meridian.schema.snapshot(provider, endpoint, today);
  console.log(`  ${color.green("✓")} snapshot saved (${Object.keys(today).length} fields)`);
  await sleep(150);

  section("Step 2 — next deploy, the upstream response shape changes");
  console.log(`  ${color.dim(JSON.stringify(afterDeploy))}`);
  console.log(`  ${color.red("✗")} \`customer_name\` is gone — no changelog, no warning`);
  await sleep(150);

  section(`Step 3 — meridian.schema.alert(${provider}, "${endpoint}", ...)`);
  let paged: string | undefined;
  const drifts = await meridian.schema.alert(provider, endpoint, afterDeploy, (_drifts, p, e) => {
    paged = `pagerDuty.trigger("Schema drift on ${p}${e}")`;
  });

  for (const drift of drifts) {
    const tag =
      drift.severity === "ERROR" ? color.red(drift.severity) : color.yellow(drift.severity);
    console.log(
      `  ${color.red("✗")} ${drift.type}  field=${color.bold(drift.field)}  severity=${tag}`,
    );
  }

  if (paged) {
    console.log(`\n  ${color.yellow("🚨")} ${paged}`);
  }

  section("Result");
  const removed = drifts.find((d) => d.type === "FIELD_REMOVED");
  console.log(`  Drift detected : ${drifts.length > 0 ? color.bold("yes") : "no"}`);
  console.log(`  Field          : ${removed?.field ?? "—"}`);
  console.log(`  Severity       : ${removed?.severity ?? "—"}`);
  console.log(
    `\n${color.green("✓")} Caught before production — your code never saw the missing field.\n`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
