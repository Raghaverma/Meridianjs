import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addProvider } from "./add.js";
import { parseOpenAPI } from "./openapi.js";

/** A small OpenAPI 3.x spec exercising every inference path. */
const SPEC_3X = {
  openapi: "3.0.0",
  info: { title: "Acme API" },
  servers: [{ url: "https://api.acme.dev/v2" }],
  components: {
    securitySchemes: {
      key: { type: "apiKey", in: "header", name: "X-Acme-Key" },
    },
    parameters: {
      Cursor: { name: "cursor", in: "query" },
    },
  },
  paths: {
    "/widgets": {
      get: {
        operationId: "listWidgets",
        parameters: [{ $ref: "#/components/parameters/Cursor" }, { name: "limit", in: "query" }],
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    data: { type: "array" },
                    next_cursor: { type: "string" },
                  },
                },
              },
            },
          },
          "401": {},
          "429": {},
          "500": {},
        },
      },
      post: { operationId: "createWidget", responses: { "201": {}, "400": {} } },
    },
    "/gadgets": {
      get: {
        operationId: "listGadgets",
        parameters: [{ name: "cursor", in: "query" }],
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { data: { type: "array" }, total: { type: "number" } },
                },
              },
            },
          },
        },
      },
    },
  },
};

const SPEC_PAGE_STYLE = {
  openapi: "3.0.0",
  info: { title: "Pager API" },
  servers: [{ url: "https://api.pager.dev" }],
  paths: {
    "/things": {
      get: {
        parameters: [
          { name: "page", in: "query" },
          { name: "per_page", in: "query" },
        ],
        responses: { "200": {} },
      },
    },
    "/stuff": {
      get: { parameters: [{ name: "page", in: "query" }], responses: { "200": {} } },
    },
  },
};

function expectValidTypeScript(source: string, fileName: string): void {
  const result = ts.transpileModule(source, {
    fileName,
    reportDiagnostics: true,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
    },
  });
  const syntaxErrors = (result.diagnostics ?? []).filter(
    (d) => d.category === ts.DiagnosticCategory.Error,
  );
  if (syntaxErrors.length > 0) {
    const messages = syntaxErrors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
    throw new Error(`Syntax errors in generated ${fileName}:\n${messages.join("\n")}`);
  }
}

describe("parseOpenAPI inference", () => {
  it("detects cursor pagination from query parameters, resolving $refs", () => {
    const spec = parseOpenAPI(SPEC_3X);
    expect(spec.pagination).toEqual({
      style: "cursor",
      param: "cursor",
      limitParam: "limit",
      occurrences: 2,
    });
  });

  it("detects page-style pagination with its limit parameter", () => {
    const spec = parseOpenAPI(SPEC_PAGE_STYLE);
    expect(spec.pagination?.style).toBe("page");
    expect(spec.pagination?.param).toBe("page");
    expect(spec.pagination?.limitParam).toBe("per_page");
  });

  it("collects the distinct documented status codes", () => {
    const spec = parseOpenAPI(SPEC_3X);
    expect(spec.documentedStatuses).toEqual([200, 201, 400, 401, 429, 500]);
  });

  it("detects the list envelope key from repeated single-array-property responses", () => {
    const spec = parseOpenAPI(SPEC_3X);
    expect(spec.envelopeKey).toBe("data");
  });

  it("captures apiKey auth location and header name", () => {
    const spec = parseOpenAPI(SPEC_3X);
    expect(spec.authType).toBe("apiKey");
    expect(spec.authSource).toBe("spec");
    expect(spec.authIn).toBe("header");
    expect(spec.authKeyName).toBe("X-Acme-Key");
  });

  it("reports heuristic sources when the spec is empty", () => {
    const spec = parseOpenAPI({});
    expect(spec.baseUrlSource).toBe("default");
    expect(spec.authSource).toBe("default");
    expect(spec.pagination).toBeNull();
    expect(spec.documentedStatuses).toEqual([]);
    expect(spec.envelopeKey).toBeNull();
  });
});

describe("addProvider", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "meridian-add-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function writeSpec(spec: unknown): Promise<string> {
    const specPath = join(dir, "spec.json");
    await writeFile(specPath, JSON.stringify(spec), "utf-8");
    return specPath;
  }

  it("generates a complete provider package from a local spec", async () => {
    const specPath = await writeSpec(SPEC_3X);
    const result = await addProvider({
      provider: "acme",
      openapi: specPath,
      output: join(dir, "out"),
    });

    expect(result.files.sort()).toEqual([
      "GENERATED.md",
      "adapter.test.ts",
      "adapter.ts",
      "contract.test.ts",
      "index.ts",
      "pagination.ts",
    ]);

    for (const file of ["adapter.ts", "adapter.test.ts", "contract.test.ts", "pagination.ts"]) {
      const source = await readFile(join(dir, "out", file), "utf-8");
      expectValidTypeScript(source, file);
    }
  });

  it("derives the adapter from the spec: base URL, auth header, spec statuses", async () => {
    const specPath = await writeSpec(SPEC_3X);
    await addProvider({ provider: "acme", openapi: specPath, output: join(dir, "out") });
    const adapter = await readFile(join(dir, "out", "adapter.ts"), "utf-8");

    expect(adapter).toContain('constructor(baseUrl = "https://api.acme.dev/v2")');
    expect(adapter).toContain('"X-Acme-Key": authToken.token');
    expect(adapter).not.toContain("Bearer ${authToken.token}");
    expect(adapter).toContain(
      "Status codes documented in the OpenAPI spec: 200, 201, 400, 401, 429, 500",
    );
    expect(adapter).toContain("429 is documented");
    // Contract requirement: empty credentials must reject with a MeridianError.
    expect(adapter).toContain(
      'throw new MeridianError("apiKey or token is required", "auth", "acme", false)',
    );
  });

  it("generates a contract test against the published subpath outside the repo", async () => {
    const specPath = await writeSpec(SPEC_3X);
    await addProvider({ provider: "acme", openapi: specPath, output: join(dir, "out") });
    const contract = await readFile(join(dir, "out", "contract.test.ts"), "utf-8");
    expect(contract).toContain('import { runProviderContract } from "meridianjs/contract"');
    expect(contract).toContain('runProviderContract("acme", new AcmeAdapter())');
  });

  it("uses the spec-derived cursor parameter in the pagination strategy", async () => {
    const specPath = await writeSpec(SPEC_3X);
    await addProvider({ provider: "acme", openapi: specPath, output: join(dir, "out") });
    const pagination = await readFile(join(dir, "out", "pagination.ts"), "utf-8");
    expect(pagination).toContain('"cursor": cursor');
    expect(pagination).toContain("derived from the OpenAPI spec");
  });

  it("generates a page-style pagination strategy when the spec uses page params", async () => {
    const specPath = await writeSpec(SPEC_PAGE_STYLE);
    await addProvider({ provider: "pager", openapi: specPath, output: join(dir, "out") });
    const pagination = await readFile(join(dir, "out", "pagination.ts"), "utf-8");
    expect(pagination).toContain("Page-number pagination inferred from the OpenAPI spec");
    expect(pagination).toContain('"page": cursor');
    expect(pagination).toContain("total_pages");
    expectValidTypeScript(pagination, "pagination.ts");
  });

  it("scores completeness and writes the GENERATED.md report", async () => {
    const specPath = await writeSpec(SPEC_3X);
    const result = await addProvider({
      provider: "acme",
      openapi: specPath,
      output: join(dir, "out"),
    });

    // Everything inferable was inferred: 15 base + 20 auth + 15 endpoints
    // + 20 pagination + 20 statuses + 10 envelope.
    expect(result.completeness.score).toBe(100);
    // Rate-limit headers and error envelopes are never in a spec — always TODOs.
    expect(result.completeness.todos).toContain(
      "Verify rate-limit header names against the provider's docs.",
    );

    const report = await readFile(join(dir, "out", "GENERATED.md"), "utf-8");
    expect(report).toContain("Completeness score: 100/100");
    expect(report).toContain("✅ from spec");
  });

  it("scores low and marks defaults for an empty spec", async () => {
    const specPath = await writeSpec({ openapi: "3.0.0", info: { title: "Mystery" } });
    const result = await addProvider({
      provider: "mystery",
      openapi: specPath,
      output: join(dir, "out"),
    });
    expect(result.completeness.score).toBe(0);
    const report = await readFile(join(dir, "out", "GENERATED.md"), "utf-8");
    expect(report).toContain("⚠️ heuristic default");
  });

  it("downloads URL sources through the injected fetcher", async () => {
    const fetched: string[] = [];
    const result = await addProvider(
      {
        provider: "acme",
        openapi: "https://specs.example.com/acme.json",
        output: join(dir, "out"),
      },
      {
        fetchText: async (url) => {
          fetched.push(url);
          return JSON.stringify(SPEC_3X);
        },
      },
    );
    expect(fetched).toEqual(["https://specs.example.com/acme.json"]);
    expect(result.specSource).toBe("https://specs.example.com/acme.json");
  });

  it("resolves known providers from the registry without an explicit source", async () => {
    const result = await addProvider(
      { provider: "slack", output: join(dir, "out") },
      { fetchText: async () => JSON.stringify(SPEC_3X) },
    );
    expect(result.specSource).toContain("slack-api-specs");
  });

  it("rejects unknown providers without a spec source, listing known ones", async () => {
    await expect(addProvider({ provider: "nonexistent-xyz" })).rejects.toThrow(
      /No OpenAPI spec source is registered.*slack/s,
    );
  });

  it("rejects YAML specs with a conversion hint", async () => {
    const yamlPath = join(dir, "spec.yaml");
    await writeFile(yamlPath, "openapi: 3.0.0\ninfo:\n  title: Yaml API\n", "utf-8");
    await expect(
      addProvider({ provider: "yamlapi", openapi: yamlPath, output: join(dir, "out") }),
    ).rejects.toThrow(/looks like YAML/);
  });

  it("refuses to overwrite an existing adapter unless --force", async () => {
    const specPath = await writeSpec(SPEC_3X);
    const output = join(dir, "out");
    await addProvider({ provider: "acme", openapi: specPath, output });
    await expect(addProvider({ provider: "acme", openapi: specPath, output })).rejects.toThrow(
      /already exists.*--force/s,
    );
    await expect(
      addProvider({ provider: "acme", openapi: specPath, output, force: true }),
    ).resolves.toBeDefined();
  });

  it("rejects invalid provider names", async () => {
    await expect(addProvider({ provider: "Bad Name!" })).rejects.toThrow(/Invalid provider name/);
  });
});
