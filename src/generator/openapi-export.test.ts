import { describe, expect, it } from "vitest";
import type { SchemaReport } from "../schema/monitor.js";
import { generateOpenApiSpec } from "./openapi-export.js";

function report(provider: string): SchemaReport {
  return {
    provider,
    generatedAt: "2026-01-01T00:00:00.000Z",
    endpoints: [
      {
        endpoint: "/v1/customers",
        version: "2026-01-01T00:00:00.000Z",
        fieldCount: 2,
        schema: {
          type: "object",
          properties: {
            id: { type: "string" },
            email: { type: "string" },
            balance: { type: "number" },
            tags: { type: "array", items: { type: "string" } },
          },
          required: ["id", "email", "balance", "tags"],
        },
      },
      {
        endpoint: "/v1/charges/{id}",
        version: "2026-01-01T00:00:00.000Z",
        fieldCount: 1,
        schema: { type: "object", properties: { amount: { type: "number" } }, required: ["amount"] },
      },
    ],
  };
}

describe("generateOpenApiSpec", () => {
  it("produces a well-formed OpenAPI 3.0 document", () => {
    const spec = generateOpenApiSpec({
      providers: [{ name: "stripe", baseUrl: "https://api.stripe.com", report: report("stripe") }],
    });

    expect(spec.openapi).toBe("3.0.3");
    expect(spec.info.title).toBe("Meridian Provider API");
    expect(spec.servers).toEqual([{ url: "https://api.stripe.com", description: "stripe" }]);
    expect(spec.tags).toEqual([{ name: "stripe" }]);
  });

  it("namespaces paths by provider and defaults to GET operations", () => {
    const spec = generateOpenApiSpec({ providers: [{ name: "stripe", report: report("stripe") }] });

    expect(spec.paths["/stripe/v1/customers"]).toBeDefined();
    expect(spec.paths["/stripe/v1/customers"]?.get).toBeDefined();
    expect(spec.paths["/stripe/v1/charges/{id}"]?.get).toBeDefined();
  });

  it("converts inferred schemas into OpenAPI response schemas", () => {
    const spec = generateOpenApiSpec({ providers: [{ name: "stripe", report: report("stripe") }] });

    const operation = spec.paths["/stripe/v1/customers"]?.get as Record<string, any>;
    const schema = operation.responses["200"].content["application/json"].schema;
    expect(schema.type).toBe("object");
    expect(schema.properties.id).toEqual({ type: "string" });
    expect(schema.properties.balance).toEqual({ type: "number" });
    expect(schema.properties.tags).toEqual({ type: "array", items: { type: "string" } });
    expect(schema.required).toEqual(["id", "email", "balance", "tags"]);
  });

  it("generates stable, readable operationIds", () => {
    const spec = generateOpenApiSpec({ providers: [{ name: "stripe", report: report("stripe") }] });
    const customers = spec.paths["/stripe/v1/customers"]?.get as Record<string, any>;
    const charges = spec.paths["/stripe/v1/charges/{id}"]?.get as Record<string, any>;
    expect(customers.operationId).toBe("stripe_get_v1_customers");
    expect(charges.operationId).toBe("stripe_get_v1_charges_id");
  });

  it("respects per-endpoint method overrides", () => {
    const spec = generateOpenApiSpec({
      providers: [
        {
          name: "stripe",
          report: report("stripe"),
          methods: { "/v1/customers": "post" },
        },
      ],
    });

    expect(spec.paths["/stripe/v1/customers"]?.post).toBeDefined();
    expect(spec.paths["/stripe/v1/customers"]?.get).toBeUndefined();
  });

  it("merges multiple providers into a single document with separate tags and servers", () => {
    const spec = generateOpenApiSpec({
      providers: [
        { name: "stripe", baseUrl: "https://api.stripe.com", report: report("stripe") },
        { name: "github", baseUrl: "https://api.github.com", report: report("github") },
      ],
    });

    expect(spec.tags).toEqual([{ name: "stripe" }, { name: "github" }]);
    expect(spec.servers).toHaveLength(2);
    expect(spec.paths["/stripe/v1/customers"]).toBeDefined();
    expect(spec.paths["/github/v1/customers"]).toBeDefined();
  });

  it("respects custom title and version", () => {
    const spec = generateOpenApiSpec({
      title: "My Internal API",
      version: "2.1.0",
      providers: [{ name: "stripe", report: report("stripe") }],
    });
    expect(spec.info).toEqual({ title: "My Internal API", version: "2.1.0" });
  });

  it("omits servers when no baseUrl is provided", () => {
    const spec = generateOpenApiSpec({ providers: [{ name: "stripe", report: report("stripe") }] });
    expect(spec.servers).toEqual([]);
  });

  it("handles providers with no observed endpoints", () => {
    const spec = generateOpenApiSpec({
      providers: [{ name: "empty", report: { provider: "empty", endpoints: [], generatedAt: "2026-01-01T00:00:00.000Z" } }],
    });
    expect(spec.tags).toEqual([{ name: "empty" }]);
    expect(Object.keys(spec.paths)).toHaveLength(0);
  });
});
