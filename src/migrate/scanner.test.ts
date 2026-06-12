import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatMigrationReport, scanForMigration } from "./scanner.js";

describe("scanForMigration", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "meridian-migrate-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function write(path: string, content: string) {
    const full = join(root, path);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content, "utf-8");
  }

  it("finds imports, instantiations, and mapped method calls", async () => {
    await write(
      "src/llm.ts",
      `import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function ask(prompt: string) {
  const res = await client.chat.completions.create({
    model: "gpt-4o",
    messages: [{ role: "user", content: prompt }],
  });
  return res.choices[0].message;
}
`,
    );

    const report = await scanForMigration("openai", root);

    expect(report.findings).toHaveLength(3);
    const kinds = report.findings.map((f) => f.kind).sort();
    expect(kinds).toEqual(["import", "instantiation", "method-call"]);

    const call = report.findings.find((f) => f.kind === "method-call")!;
    expect(call.file).toBe(join("src", "llm.ts"));
    expect(call.line).toBe(6);
    expect(call.confidence).toBe("clean");
    expect(call.suggestion).toContain('meridian.openai.post("/v1/chat/completions"');

    expect(report.cleanCount).toBe(1);
    expect(report.manualCount).toBe(2);
    expect(report.filesAffected).toBe(1);
  });

  it("flags streaming usage as manual", async () => {
    await write(
      "stream.ts",
      `const res = await client.chat.completions.create({ model: "gpt-4o", stream: true });`,
    );
    const report = await scanForMigration("openai", root);
    const manual = report.findings.find((f) => f.detail.includes("Streaming"));
    expect(manual).toBeDefined();
    expect(manual!.confidence).toBe("manual");
    expect(manual!.suggestion).toContain(".stream(");
  });

  it("detects hand-rolled HTTP calls by API host", async () => {
    await write(
      "raw.js",
      `const res = await fetch("https://api.stripe.com/v1/charges", { method: "POST" });`,
    );
    const report = await scanForMigration("stripe", root);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]!.kind).toBe("http-call");
    expect(report.findings[0]!.confidence).toBe("manual");
  });

  it("skips node_modules, dist, and comments", async () => {
    await write("node_modules/openai/index.js", `module.exports = {}; // openai itself`);
    await write("dist/bundle.js", `var x = require("openai");`);
    await write("src/notes.ts", `// import OpenAI from "openai" — old approach, removed`);
    const report = await scanForMigration("openai", root);
    expect(report.findings).toHaveLength(0);
  });

  it("supports require() and dynamic import detection", async () => {
    await write("cjs.cjs", `const Stripe = require("stripe");`);
    await write("dyn.ts", `const stripe = await import("stripe");`);
    const report = await scanForMigration("stripe", root);
    expect(report.findings.filter((f) => f.kind === "import")).toHaveLength(2);
  });

  it("rejects unknown providers with the supported list", async () => {
    await expect(scanForMigration("not-a-provider", root)).rejects.toThrow(
      /No migration mapping.*openai/s,
    );
  });

  it("renders a readable report with config snippet", async () => {
    await write(
      "src/billing.ts",
      `import Stripe from "stripe";
const stripe = new Stripe(key);
await stripe.paymentIntents.create({ amount: 100 });
await stripe.customers.retrieve(id);
`,
    );
    const report = await scanForMigration("stripe", root);
    const out = formatMigrationReport(report);

    expect(out).toContain("Migration scan: stripe");
    expect(out).toContain(join("src", "billing.ts"));
    expect(out).toContain("✓"); // clean finding marker
    expect(out).toContain("map cleanly to Meridian calls");
    expect(out).toContain("need manual attention");
    expect(out).toContain("STRIPE_SECRET_KEY");
    expect(out).toContain("No files were modified.");
  });

  it("reports an empty scan cleanly", async () => {
    await write("src/app.ts", `export const x = 1;`);
    const report = await scanForMigration("openai", root);
    const out = formatMigrationReport(report);
    expect(report.findings).toHaveLength(0);
    expect(out).toContain("nothing to migrate");
  });
});
