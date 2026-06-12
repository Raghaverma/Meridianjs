import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ParsedSpec, parseOpenAPI } from "./openapi.js";
import { type KnownProviderSpec, listKnownProviders, resolveKnownProvider } from "./registry.js";
import {
  type CompletenessItem,
  type CompletenessReport,
  type GeneratorContext,
  generateAdapter,
  generateContractTest,
  generateIndex,
  generatePagination,
  generateReport,
  generateTest,
} from "./templates.js";

export interface AddOptions {
  provider: string;
  /** Explicit OpenAPI source — local path or http(s) URL. Overrides the registry. */
  openapi?: string;
  /** Output directory. Defaults to src/providers/<provider>. */
  output?: string;
  baseUrl?: string;
  auth?: "apiKey" | "bearer" | "basic" | "oauth2";
  /** Overwrite an existing generated adapter. */
  force?: boolean;
}

/** Injection points so tests don't hit the network. */
export interface AddDeps {
  fetchText?: (url: string) => Promise<string>;
}

export interface AddResult {
  provider: string;
  outputDir: string;
  files: string[];
  specSource: string | null;
  completeness: CompletenessReport;
}

async function defaultFetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to download OpenAPI spec (${res.status} ${res.statusText}): ${url}`);
  }
  return res.text();
}

function looksLikeUrl(source: string): boolean {
  return /^https?:\/\//i.test(source);
}

async function loadSpecText(source: string, deps: AddDeps): Promise<string> {
  if (looksLikeUrl(source)) {
    return (deps.fetchText ?? defaultFetchText)(source);
  }
  return readFile(source, "utf-8");
}

function parseSpecDocument(raw: string, source: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    const yamlish = /\.ya?ml$/i.test(source) || !raw.trimStart().startsWith("{");
    if (yamlish) {
      throw new Error(
        `The OpenAPI spec at ${source} looks like YAML; meridian add reads JSON specs only. ` +
          "Convert it (e.g. `npx js-yaml spec.yaml > spec.json`) and re-run with --openapi spec.json.",
      );
    }
    throw new Error(`The OpenAPI spec at ${source} is not valid JSON.`);
  }
}

async function detectContractImport(outputDir: string): Promise<string> {
  // Generated inside the meridianjs repo itself (src/providers/<name>) the
  // contract helper is a relative module; in consumer projects it's the
  // published subpath export.
  try {
    await access(join(outputDir, "..", "..", "testing", "contract.ts"));
    return "../../testing/contract.js";
  } catch {
    return "meridianjs/contract";
  }
}

interface ResolvedAspects {
  ctx: GeneratorContext;
  completeness: CompletenessReport;
}

function buildContext(
  provider: string,
  spec: ParsedSpec | null,
  known: KnownProviderSpec | null,
  opts: AddOptions,
  contractImport: string,
): ResolvedAspects {
  const items: CompletenessItem[] = [];
  const todos: string[] = [];
  let score = 0;

  // Base URL (15): flag > spec > curated registry > heuristic guess.
  let baseUrl: string;
  if (opts.baseUrl) {
    baseUrl = opts.baseUrl;
    score += 15;
    items.push({ aspect: "Base URL", source: "spec", detail: `${baseUrl} (from --base-url)` });
  } else if (spec && spec.baseUrlSource === "spec") {
    baseUrl = spec.baseUrl;
    score += 15;
    items.push({ aspect: "Base URL", source: "spec", detail: baseUrl });
  } else if (known?.baseUrl) {
    baseUrl = known.baseUrl;
    score += 15;
    items.push({ aspect: "Base URL", source: "spec", detail: `${baseUrl} (curated registry)` });
  } else {
    baseUrl = spec?.baseUrl ?? `https://api.${provider}.com`;
    items.push({ aspect: "Base URL", source: "default", detail: `${baseUrl} (guessed)` });
    todos.push(`Confirm the base URL (guessed as ${baseUrl}).`);
  }

  // Auth (20): flag > spec > curated registry > apiKey default.
  let authType: GeneratorContext["authType"];
  let apiKeyHeader: string | undefined;
  let apiKeyQuery: string | undefined;
  if (opts.auth) {
    authType = opts.auth;
    score += 20;
    items.push({ aspect: "Auth scheme", source: "spec", detail: `${authType} (from --auth)` });
  } else if (spec && spec.authSource === "spec") {
    authType = spec.authType;
    score += 20;
    let detail: string = authType;
    if (authType === "apiKey") {
      if (spec.authIn === "query") {
        apiKeyQuery = spec.authKeyName;
        detail = `apiKey in query parameter "${spec.authKeyName}"`;
      } else {
        apiKeyHeader = spec.authKeyName;
        detail = `apiKey in header "${spec.authKeyName}"`;
      }
    }
    items.push({ aspect: "Auth scheme", source: "spec", detail });
  } else if (known?.auth) {
    authType = known.auth;
    score += 20;
    items.push({ aspect: "Auth scheme", source: "spec", detail: `${authType} (curated registry)` });
  } else {
    authType = "apiKey";
    items.push({ aspect: "Auth scheme", source: "default", detail: "apiKey via Bearer header" });
    todos.push("Confirm the auth scheme (defaulted to Bearer token).");
  }

  // Endpoints (15).
  const endpoints = spec?.endpoints ?? [];
  if (endpoints.length > 0) {
    score += 15;
    items.push({
      aspect: "Endpoints",
      source: "spec",
      detail: `${endpoints.length} operations extracted`,
    });
  } else {
    items.push({ aspect: "Endpoints", source: "default", detail: "none extracted" });
    todos.push("No endpoints were extracted from the spec — check the spec source.");
  }

  // Pagination (20).
  let pagination: GeneratorContext["pagination"];
  if (spec?.pagination) {
    score += 20;
    pagination = {
      style: spec.pagination.style,
      param: spec.pagination.param,
      source: "spec",
      ...(spec.pagination.limitParam !== undefined && { limitParam: spec.pagination.limitParam }),
    };
    items.push({
      aspect: "Pagination",
      source: "spec",
      detail: `${spec.pagination.style}-style via "${spec.pagination.param}" (seen in ${spec.pagination.occurrences} operations)`,
    });
  } else {
    items.push({
      aspect: "Pagination",
      source: "default",
      detail: "multi-convention cursor heuristics",
    });
    todos.push("Verify the pagination parameter and response cursor field names.");
  }

  // Retry classification (20): grounded in which statuses the spec documents.
  const statuses = spec?.documentedStatuses ?? [];
  const documented4xx = statuses.some((s) => s >= 400 && s < 500);
  const documented5xx = statuses.some((s) => s >= 500);
  const documented429 = statuses.includes(429);
  if (documented429) score += 10;
  if (documented5xx) score += 5;
  if (documented4xx) score += 5;
  if (statuses.length > 0) {
    items.push({
      aspect: "Retry classification",
      source: documented429 ? "spec" : "default",
      detail: `spec documents: ${statuses.filter((s) => s >= 400).join(", ") || "no error statuses"}${
        documented429 ? "" : " — 429 handling is assumed"
      }`,
    });
  } else {
    items.push({
      aspect: "Retry classification",
      source: "default",
      detail: "universal HTTP semantics (401/403→auth, 429→rate_limit, 5xx→retryable)",
    });
  }
  if (!documented429) {
    todos.push("Confirm how the provider signals rate limiting (429 not documented in spec).");
  }

  // Normalization envelope (10).
  const envelopeKey = spec?.envelopeKey ?? null;
  if (envelopeKey) {
    score += 10;
    items.push({
      aspect: "Response envelope",
      source: "spec",
      detail: `list payloads under "${envelopeKey}"`,
    });
  } else {
    items.push({
      aspect: "Response envelope",
      source: "default",
      detail: "body passed through unchanged",
    });
  }

  // Not derivable from OpenAPI at all — always flagged.
  todos.push("Verify rate-limit header names against the provider's docs.");
  todos.push("Verify the error envelope field names against a real error response.");

  const ctx: GeneratorContext = {
    provider,
    baseUrl,
    authType,
    authKeyName: spec?.authKeyName ?? "apiKey",
    endpoints,
    envelopeKey,
    contractImport,
    ...(apiKeyHeader !== undefined && { apiKeyHeader }),
    ...(apiKeyQuery !== undefined && { apiKeyQuery }),
    ...(pagination !== undefined && { pagination }),
    ...(statuses.length > 0 && { documentedStatuses: statuses }),
  };

  return { ctx, completeness: { score, items, todos } };
}

export async function addProvider(opts: AddOptions, deps: AddDeps = {}): Promise<AddResult> {
  const provider = opts.provider.toLowerCase().trim();
  if (!/^[a-z][a-z0-9_-]*$/.test(provider)) {
    throw new Error(
      `Invalid provider name "${opts.provider}". Use lowercase letters, digits, "-" or "_".`,
    );
  }

  const known = resolveKnownProvider(provider);
  const source = opts.openapi ?? known?.specUrl ?? null;
  if (!source) {
    const knownNames = listKnownProviders()
      .map((p) => p.name)
      .join(", ");
    throw new Error(
      `No OpenAPI spec source is registered for "${provider}".\n` +
        `Providers with registered specs: ${knownNames}.\n` +
        `For anything else, point at a spec directly:\n` +
        `  meridian add ${provider} --openapi <url-or-path>`,
    );
  }

  let spec: ParsedSpec | null = null;
  let raw: string;
  try {
    raw = await loadSpecText(source, deps);
  } catch (err) {
    const hint = known
      ? `\nThe registered spec URL may have moved — check ${known.docsUrl} and pass --openapi <url-or-path> explicitly.`
      : "";
    throw new Error(`${err instanceof Error ? err.message : String(err)}${hint}`);
  }
  spec = parseOpenAPI(parseSpecDocument(raw, source));

  const outputDir = opts.output ?? join("src", "providers", provider);
  const contractImport = await detectContractImport(outputDir);
  const { ctx, completeness } = buildContext(provider, spec, known, opts, contractImport);

  const adapterPath = join(outputDir, "adapter.ts");
  if (!opts.force) {
    try {
      await access(adapterPath);
      throw new Error(
        `${adapterPath} already exists. Re-run with --force to overwrite the generated files.`,
      );
    } catch (err) {
      if (err instanceof Error && err.message.includes("already exists")) throw err;
      // ENOENT — nothing to overwrite.
    }
  }

  await mkdir(outputDir, { recursive: true });

  const files: Array<[string, string]> = [
    ["adapter.ts", generateAdapter(ctx)],
    ["adapter.test.ts", generateTest(ctx)],
    ["contract.test.ts", generateContractTest(ctx)],
    ["pagination.ts", generatePagination(ctx)],
    ["index.ts", generateIndex(ctx)],
    ["GENERATED.md", generateReport(ctx, completeness)],
  ];
  await Promise.all(
    files.map(([name, content]) => writeFile(join(outputDir, name), content, "utf-8")),
  );

  return {
    provider,
    outputDir,
    files: files.map(([name]) => name),
    specSource: source,
    completeness,
  };
}

export function formatAddResult(result: AddResult): string {
  const { completeness } = result;
  const todoLines = completeness.todos.map((t) => `     - ${t}`).join("\n");
  return [
    `✓  Generated provider "${result.provider}" → ${result.outputDir}/`,
    `   Spec source: ${result.specSource}`,
    "",
    "   adapter.ts        auth, error mapping, retry classification, rate-limit headers",
    "   pagination.ts     pagination strategy",
    "   adapter.test.ts   provider unit tests",
    "   contract.test.ts  the universal Meridian provider contract (19 invariants)",
    "   GENERATED.md      completeness report — what was inferred vs assumed",
    "",
    `   Completeness: ${completeness.score}/100 (see GENERATED.md)`,
    "   Before shipping:",
    todoLines,
    "",
    "   Run the generated tests:",
    `     npx vitest run ${result.provider}`,
  ].join("\n");
}
