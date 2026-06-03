import { describe, expect, it } from "vitest";
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
});
