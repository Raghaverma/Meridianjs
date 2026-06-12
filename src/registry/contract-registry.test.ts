import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ContractRegistry } from "./contract-registry.js";

const V1 = { id: "ch_1", amount: 100, currency: "usd" };
const V1_SAME_SHAPE = { id: "ch_2", amount: 250, currency: "eur" };
const V2_FIELD_ADDED = { id: "ch_3", amount: 100, currency: "usd", captured: true };
const V3_FIELD_REMOVED = { id: "ch_4", amount: 100 };
const V3_TYPE_CHANGED = { id: "ch_5", amount: "100", currency: "usd" };

describe("ContractRegistry", () => {
  let dir: string;
  let registry: ContractRegistry;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "meridian-registry-"));
    registry = new ContractRegistry(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("registers the first snapshot as v1", async () => {
    const result = await registry.snapshot("stripe", "/v1/charges", V1);
    expect(result).toMatchObject({ version: 1, created: true, drifts: [] });
  });

  it("treats an identical schema as a no-op", async () => {
    await registry.snapshot("stripe", "/v1/charges", V1);
    const again = await registry.snapshot("stripe", "/v1/charges", V1_SAME_SHAPE);
    expect(again).toMatchObject({ version: 1, created: false });
  });

  it("versions schema changes and records drift history", async () => {
    await registry.snapshot("stripe", "/v1/charges", V1);
    const v2 = await registry.snapshot("stripe", "/v1/charges", V2_FIELD_ADDED);
    expect(v2.version).toBe(2);
    expect(v2.created).toBe(true);
    expect(v2.drifts.some((d) => d.type === "REQUIRED_ADDED" && d.field === "captured")).toBe(true);

    const history = await registry.history("stripe", "/v1/charges");
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ fromVersion: 1, toVersion: 2 });
  });

  it("check() flags breaking drift without writing", async () => {
    await registry.snapshot("stripe", "/v1/charges", V1);

    const removed = await registry.check("stripe", "/v1/charges", V3_FIELD_REMOVED);
    expect(removed.breaking).toBe(true);
    expect(removed.drifts.some((d) => d.type === "FIELD_REMOVED" && d.field === "currency")).toBe(
      true,
    );

    const typeChanged = await registry.check("stripe", "/v1/charges", V3_TYPE_CHANGED);
    expect(typeChanged.breaking).toBe(true);
    expect(typeChanged.drifts.some((d) => d.type === "TYPE_CHANGED" && d.field === "amount")).toBe(
      true,
    );

    // Read-only: still only v1 on disk.
    const again = await registry.check("stripe", "/v1/charges", V1);
    expect(again.againstVersion).toBe(1);
  });

  it("treats additive drift as non-breaking", async () => {
    await registry.snapshot("stripe", "/v1/charges", V1);
    const check = await registry.check("stripe", "/v1/charges", V2_FIELD_ADDED);
    expect(check.breaking).toBe(false);
    expect(check.drifts.length).toBeGreaterThan(0);
  });

  it("check() against an unregistered endpoint is clean", async () => {
    const check = await registry.check("stripe", "/v1/unknown", V1);
    expect(check).toMatchObject({ againstVersion: null, drifts: [], breaking: false });
  });

  it("lists endpoints and builds the provider report", async () => {
    await registry.snapshot("stripe", "/v1/charges", V1);
    await registry.snapshot("stripe", "/v1/charges", V3_FIELD_REMOVED);
    await registry.snapshot("stripe", "/v1/customers", { id: "cus_1" });

    expect(await registry.list("stripe")).toEqual(["/v1/charges", "/v1/customers"]);

    const report = await registry.report("stripe");
    expect(report.provider).toBe("stripe");
    expect(report.endpoints).toHaveLength(2);
    const charges = report.endpoints.find((e) => e.endpoint === "/v1/charges")!;
    expect(charges).toMatchObject({
      latestVersion: 2,
      driftEvents: 1,
      breakingEvents: 1,
    });
  });

  it("disambiguates endpoints that slugify identically", async () => {
    await registry.snapshot("acme", "/a/b", { x: 1 });
    await registry.snapshot("acme", "/a-b", { y: "two" });
    expect((await registry.list("acme")).sort()).toEqual(["/a-b", "/a/b"]);
    const providerDir = await readdir(join(dir, "acme"));
    expect(providerDir).toHaveLength(2);
  });

  it("returns empty results for unknown providers", async () => {
    expect(await registry.list("nobody")).toEqual([]);
    expect((await registry.report("nobody")).endpoints).toEqual([]);
    expect(await registry.history("nobody", "/x")).toEqual([]);
  });
});
