import { describe, expect, it, vi } from "vitest";
import { InMemorySchemaStorage } from "../validation/schema-storage.js";
import { SchemaMonitor } from "./monitor.js";

const storage = () => new InMemorySchemaStorage();

describe("SchemaMonitor", () => {
  describe("snapshot", () => {
    it("saves schema without error", async () => {
      const m = new SchemaMonitor(storage());
      await expect(
        m.snapshot("stripe", "/v1/customers", { id: "cu_1", email: "a@b.com" }),
      ).resolves.not.toThrow();
    });

    it("snapshot is retrievable via list", async () => {
      const s = storage();
      const m = new SchemaMonitor(s);
      await m.snapshot("stripe", "/v1/customers", { id: "cu_1" });
      const schemas = await m.list("stripe");
      expect(schemas).toHaveLength(1);
      expect(schemas[0]!.provider).toBe("stripe");
      expect(schemas[0]!.endpoint).toBe("/v1/customers");
    });
  });

  describe("check", () => {
    it("returns empty drifts and baselines on first check", async () => {
      const m = new SchemaMonitor(storage());
      const drifts = await m.check("stripe", "/v1/customers", { id: "cu_1", name: "Alice" });
      expect(drifts).toHaveLength(0);
    });

    it("detects no drift when schema is identical", async () => {
      const m = new SchemaMonitor(storage());
      const data = { id: "cu_1", name: "Alice", amount: 100 };
      await m.snapshot("stripe", "/v1/customers", data);
      const drifts = await m.check("stripe", "/v1/customers", data);
      expect(drifts).toHaveLength(0);
    });

    it("detects FIELD_REMOVED", async () => {
      const m = new SchemaMonitor(storage());
      await m.snapshot("stripe", "/v1/customers", { id: "cu_1", customer_name: "Alice" });
      const drifts = await m.check("stripe", "/v1/customers", { id: "cu_1" });
      expect(drifts.some((d) => d.type === "FIELD_REMOVED" && d.field === "customer_name")).toBe(
        true,
      );
    });

    it("detects TYPE_CHANGED", async () => {
      const m = new SchemaMonitor(storage());
      await m.snapshot("stripe", "/v1/charges", { amount: 100 }); // number
      const drifts = await m.check("stripe", "/v1/charges", { amount: "100" }); // now string
      expect(drifts.some((d) => d.type === "TYPE_CHANGED" && d.field === "amount")).toBe(true);
    });

    it("reports FIELD_REMOVED as ERROR severity", async () => {
      const m = new SchemaMonitor(storage());
      await m.snapshot("stripe", "/v1/customers", { id: "cu_1", legacy_field: "x" });
      const drifts = await m.check("stripe", "/v1/customers", { id: "cu_1" });
      const removed = drifts.find((d) => d.field === "legacy_field");
      expect(removed?.severity).toBe("ERROR");
    });

    it("handles nested object schemas", async () => {
      const m = new SchemaMonitor(storage());
      await m.snapshot("stripe", "/v1/customers", { address: { city: "NYC", zip: "10001" } });
      // zip removed from address
      const drifts = await m.check("stripe", "/v1/customers", { address: { city: "NYC" } });
      expect(drifts.length).toBeGreaterThan(0);
    });

    it("handles array schemas", async () => {
      const m = new SchemaMonitor(storage());
      await m.snapshot("stripe", "/v1/customers", { items: [{ id: 1, name: "a" }] });
      const drifts = await m.check("stripe", "/v1/customers", { items: [{ id: 1 }] });
      expect(drifts.length).toBeGreaterThan(0);
    });

    it("returns empty for providers with no snapshots", async () => {
      const m = new SchemaMonitor(storage());
      const schemas = await m.list("unknown-provider");
      expect(schemas).toHaveLength(0);
    });
  });

  describe("diff", () => {
    it("returns empty on first call (baselines)", async () => {
      const m = new SchemaMonitor(storage());
      const drifts = await m.diff("stripe", "/v1/customers", { id: "cu_1", name: "Alice" });
      expect(drifts).toHaveLength(0);
    });

    it("detects removed fields between snapshot and diff", async () => {
      const m = new SchemaMonitor(storage());
      await m.snapshot("stripe", "/v1/customers", { id: "cu_1", legacy: "x" });
      const drifts = await m.diff("stripe", "/v1/customers", { id: "cu_1" });
      expect(drifts.some((d) => d.field === "legacy")).toBe(true);
    });

    it("returns same result as check for identical inputs", async () => {
      const s = storage();
      const m1 = new SchemaMonitor(s);
      const m2 = new SchemaMonitor(s);
      await m1.snapshot("stripe", "/v1/charges", { amount: 100 });
      const check = await m1.check("stripe", "/v1/charges", { amount: "100" });
      await m2.snapshot("stripe", "/v1/charges", { amount: 100 });
      const diff = await m2.diff("stripe", "/v1/charges", { amount: "100" });
      expect(diff).toEqual(check);
    });
  });

  describe("report", () => {
    it("returns a report with provider and generatedAt", async () => {
      const m = new SchemaMonitor(storage());
      await m.snapshot("stripe", "/v1/customers", { id: "cu_1", name: "Alice" });
      const report = await m.report("stripe");
      expect(report.provider).toBe("stripe");
      expect(report.generatedAt).toBeTruthy();
      expect(new Date(report.generatedAt).getTime()).not.toBeNaN();
    });

    it("includes snapshotted endpoints", async () => {
      const m = new SchemaMonitor(storage());
      await m.snapshot("stripe", "/v1/customers", { id: "cu_1" });
      await m.snapshot("stripe", "/v1/charges", { amount: 100 });
      const report = await m.report("stripe");
      const endpoints = report.endpoints.map((e) => e.endpoint);
      expect(endpoints).toContain("/v1/customers");
      expect(endpoints).toContain("/v1/charges");
    });

    it("includes correct field count for object schemas", async () => {
      const m = new SchemaMonitor(storage());
      await m.snapshot("stripe", "/v1/customers", { id: "cu_1", name: "Alice", email: "a@b.com" });
      const report = await m.report("stripe");
      const entry = report.endpoints.find((e) => e.endpoint === "/v1/customers");
      expect(entry?.fieldCount).toBe(3);
    });

    it("returns empty endpoints for provider with no snapshots", async () => {
      const m = new SchemaMonitor(storage());
      const report = await m.report("unknown");
      expect(report.endpoints).toHaveLength(0);
    });
  });

  describe("alert", () => {
    it("does not call callback when no drift", async () => {
      const m = new SchemaMonitor(storage());
      const data = { id: "cu_1", name: "Alice" };
      await m.snapshot("stripe", "/v1/customers", data);
      const cb = vi.fn();
      await m.alert("stripe", "/v1/customers", data, cb);
      expect(cb).not.toHaveBeenCalled();
    });

    it("calls callback with drifts when drift detected", async () => {
      const m = new SchemaMonitor(storage());
      await m.snapshot("stripe", "/v1/customers", { id: "cu_1", legacy: "x" });
      const cb = vi.fn();
      await m.alert("stripe", "/v1/customers", { id: "cu_1" }, cb);
      expect(cb).toHaveBeenCalledOnce();
      const [drifts, provider, endpoint] = cb.mock.calls[0] as [unknown[], string, string];
      expect(provider).toBe("stripe");
      expect(endpoint).toBe("/v1/customers");
      expect(Array.isArray(drifts) && drifts.length > 0).toBe(true);
    });

    it("returns the drifts array regardless of callback", async () => {
      const m = new SchemaMonitor(storage());
      await m.snapshot("stripe", "/v1/customers", { id: "cu_1", gone: true });
      const drifts = await m.alert("stripe", "/v1/customers", { id: "cu_1" }, () => {});
      expect(drifts.length).toBeGreaterThan(0);
    });

    it("baselines on first alert call", async () => {
      const m = new SchemaMonitor(storage());
      const cb = vi.fn();
      const drifts = await m.alert("stripe", "/v1/new-endpoint", { id: "cu_1" }, cb);
      expect(drifts).toHaveLength(0);
      expect(cb).not.toHaveBeenCalled();
    });
  });
});
