import ts from "typescript";
import { describe, expect, it } from "vitest";
import { generateAdapter, generateIndex, generatePagination, generateTest } from "./templates.js";
import type { GeneratorContext } from "./templates.js";

function baseCtx(overrides: Partial<GeneratorContext> = {}): GeneratorContext {
  return {
    provider: "acme",
    baseUrl: "https://api.acme.com",
    authType: "apiKey",
    authKeyName: "apiKey",
    endpoints: [],
    ...overrides,
  };
}

/** Asserts the generated source has no syntax errors (it's valid TypeScript). */
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

describe("generator templates", () => {
  describe("generateAdapter", () => {
    it("produces syntactically valid TypeScript", () => {
      const source = generateAdapter(baseCtx());
      expectValidTypeScript(source, "adapter.ts");
    });

    it("includes a provider-agnostic error message extractor covering common API shapes", () => {
      const source = generateAdapter(baseCtx());
      expect(source).toContain("function extractErrorMessage(body: unknown): string | null");
      expect(source).toContain("b.message");
      expect(source).toContain("b.error_description");
      expect(source).toContain("b.detail");
      expect(source).toContain("b.errors");
      expect(source).toContain("extractErrorMessage(body) ?? `HTTP ${status}`");
    });

    it("checks multiple rate-limit header naming conventions", () => {
      const source = generateAdapter(baseCtx());
      expect(source).toContain("x-ratelimit-limit");
      expect(source).toContain("x-rate-limit-limit");
      expect(source).toContain("ratelimit-limit");
      expect(source).toContain("retry-after");
    });

    it("references the provider name and pagination strategy class", () => {
      const source = generateAdapter(baseCtx({ provider: "acme-pay" }));
      expect(source).toContain('"acme-pay"');
      expect(source).toContain("class AcmePayAdapter implements ProviderAdapter");
      expect(source).toContain("AcmePayPaginationStrategy");
    });

    it("uses Basic auth header construction when authType is basic", () => {
      const source = generateAdapter(baseCtx({ authType: "basic" }));
      expect(source).toContain("Basic ${Buffer.from");
      expect(source).toContain("authToken.secret");
    });
  });

  describe("generatePagination", () => {
    it("produces syntactically valid TypeScript", () => {
      const source = generatePagination(baseCtx());
      expectValidTypeScript(source, "pagination.ts");
    });

    it("checks multiple cursor field conventions including nested and Relay-style shapes", () => {
      const source = generatePagination(baseCtx());
      expect(source).toContain("body.next_cursor");
      expect(source).toContain("body.cursor");
      expect(source).toContain("body.next");
      expect(source).toContain("body.next_page");
      expect(source).toContain("meta?.next_cursor");
      expect(source).toContain("pagination?.next_cursor");
      expect(source).toContain("page_info");
      expect(source).toContain("end_cursor");
    });

    it("extracts a total from common top-level and nested meta fields", () => {
      const source = generatePagination(baseCtx());
      expect(source).toContain("body.total");
      expect(source).toContain("meta?.total");
    });

    it("names the generated class after the provider", () => {
      const source = generatePagination(baseCtx({ provider: "acme-pay" }));
      expect(source).toContain("class AcmePayPaginationStrategy implements PaginationStrategy");
    });
  });

  describe("generateIndex", () => {
    it("produces a barrel export for the adapter", () => {
      const source = generateIndex(baseCtx({ provider: "acme-pay" }));
      expect(source.trim()).toBe('export { AcmePayAdapter } from "./adapter.js";');
    });
  });

  describe("generateTest", () => {
    it("produces syntactically valid TypeScript", () => {
      const source = generateTest(baseCtx());
      expectValidTypeScript(source, "adapter.test.ts");
    });
  });
});
