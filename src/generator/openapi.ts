interface ParameterObject {
  $ref?: string;
  name?: string;
  in?: string;
}

interface SchemaObject {
  $ref?: string;
  type?: string;
  properties?: Record<string, SchemaObject>;
  items?: SchemaObject;
}

interface ResponseObject {
  schema?: SchemaObject; // OpenAPI 2.0
  content?: Record<string, { schema?: SchemaObject }>; // OpenAPI 3.x
}

interface OperationObject {
  operationId?: string;
  summary?: string;
  parameters?: ParameterObject[];
  responses?: Record<string, ResponseObject>;
}

interface OpenAPIDoc {
  openapi?: string;
  swagger?: string;
  info?: { title?: string };
  servers?: Array<{ url: string }>;
  host?: string;
  basePath?: string;
  paths?: Record<string, Record<string, OperationObject | ParameterObject[]>>;
  components?: {
    securitySchemes?: Record<string, { type: string; scheme?: string; in?: string; name?: string }>;
    parameters?: Record<string, ParameterObject>;
    schemas?: Record<string, SchemaObject>;
  };
  securityDefinitions?: Record<
    string,
    { type: string; scheme?: string; in?: string; name?: string }
  >;
  parameters?: Record<string, ParameterObject>; // OpenAPI 2.0
  definitions?: Record<string, SchemaObject>; // OpenAPI 2.0
}

export interface PaginationHint {
  style: "cursor" | "offset" | "page";
  param: string;
  limitParam?: string;
  /** How many operations in the spec reference this parameter. */
  occurrences: number;
}

export interface ParsedSpec {
  title: string;
  baseUrl: string;
  /** Whether baseUrl came from the spec or is a heuristic default. */
  baseUrlSource: "spec" | "default";
  authType: "apiKey" | "bearer" | "basic" | "oauth2";
  authSource: "spec" | "default";
  authKeyName: string;
  /** Where an apiKey credential goes, when the spec says ("header" | "query"). */
  authIn: "header" | "query";
  endpoints: Array<{ method: string; path: string; operationId?: string }>;
  /** Dominant pagination parameter across operations, when one is detectable. */
  pagination: PaginationHint | null;
  /** Distinct HTTP status codes the spec documents across all operations. */
  documentedStatuses: number[];
  /** The single array-valued property most list responses wrap data in, if any. */
  envelopeKey: string | null;
}

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete"]);

const CURSOR_PARAMS = new Set([
  "cursor",
  "next_cursor",
  "page_token",
  "pagetoken",
  "after",
  "starting_after",
  "next_token",
  "continuation_token",
]);
const PAGE_PARAMS = new Set(["page", "page_number", "pagenumber"]);
const OFFSET_PARAMS = new Set(["offset", "skip", "start"]);
const LIMIT_PARAMS = ["limit", "per_page", "page_size", "pagesize", "count", "max_results"];

// Envelope keys APIs commonly wrap list payloads in, in tie-break preference order.
const ENVELOPE_PREFERENCE = ["data", "items", "results", "records", "entries", "list"];

function resolveParameter(param: ParameterObject, spec: OpenAPIDoc): ParameterObject {
  if (!param.$ref) return param;
  const name = param.$ref.split("/").pop() ?? "";
  return spec.components?.parameters?.[name] ?? spec.parameters?.[name] ?? param;
}

function resolveSchema(schema: SchemaObject | undefined, spec: OpenAPIDoc): SchemaObject | null {
  if (!schema) return null;
  if (!schema.$ref) return schema;
  const name = schema.$ref.split("/").pop() ?? "";
  // One level of $ref resolution is enough for envelope detection; nested
  // refs inside properties are inspected only for their `type`.
  return spec.components?.schemas?.[name] ?? spec.definitions?.[name] ?? null;
}

function isOperation(value: OperationObject | ParameterObject[]): value is OperationObject {
  return !Array.isArray(value);
}

function detectPagination(spec: OpenAPIDoc): PaginationHint | null {
  const counts = new Map<string, { style: PaginationHint["style"]; count: number }>();
  let limitParam: string | undefined;

  for (const pathItem of Object.values(spec.paths ?? {})) {
    for (const [method, op] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method) || !isOperation(op)) continue;
      const pathLevel = (pathItem.parameters as ParameterObject[] | undefined) ?? [];
      for (const raw of [...(op.parameters ?? []), ...pathLevel]) {
        const param = resolveParameter(raw, spec);
        if (param.in !== "query" || !param.name) continue;
        const name = param.name.toLowerCase();

        let style: PaginationHint["style"] | null = null;
        if (CURSOR_PARAMS.has(name)) style = "cursor";
        else if (PAGE_PARAMS.has(name)) style = "page";
        else if (OFFSET_PARAMS.has(name)) style = "offset";

        if (style) {
          const entry = counts.get(param.name) ?? { style, count: 0 };
          entry.count++;
          counts.set(param.name, entry);
        }
        if (!limitParam && LIMIT_PARAMS.includes(name)) {
          limitParam = param.name;
        }
      }
    }
  }

  if (counts.size === 0) return null;

  // Deterministic: highest occurrence count wins; ties prefer cursor over
  // page over offset, then lexicographic param name.
  const stylePriority: Record<PaginationHint["style"], number> = { cursor: 0, page: 1, offset: 2 };
  const ranked = [...counts.entries()].sort((a, b) => {
    if (b[1].count !== a[1].count) return b[1].count - a[1].count;
    if (stylePriority[a[1].style] !== stylePriority[b[1].style]) {
      return stylePriority[a[1].style] - stylePriority[b[1].style];
    }
    return a[0].localeCompare(b[0]);
  });

  const [param, { style, count }] = ranked[0]!;
  const hint: PaginationHint = { style, param, occurrences: count };
  if (limitParam !== undefined) hint.limitParam = limitParam;
  return hint;
}

function collectDocumentedStatuses(spec: OpenAPIDoc): number[] {
  const statuses = new Set<number>();
  for (const pathItem of Object.values(spec.paths ?? {})) {
    for (const [method, op] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method) || !isOperation(op)) continue;
      for (const code of Object.keys(op.responses ?? {})) {
        const n = Number(code);
        if (Number.isInteger(n) && n >= 100 && n < 600) statuses.add(n);
      }
    }
  }
  return [...statuses].sort((a, b) => a - b);
}

function successSchema(op: OperationObject, spec: OpenAPIDoc): SchemaObject | null {
  const response = op.responses?.["200"] ?? op.responses?.["201"];
  if (!response) return null;
  const raw =
    response.schema ?? // 2.0
    response.content?.["application/json"]?.schema ?? // 3.x
    null;
  return raw ? resolveSchema(raw, spec) : null;
}

function detectEnvelopeKey(spec: OpenAPIDoc): string | null {
  const counts = new Map<string, number>();
  let listResponses = 0;

  for (const pathItem of Object.values(spec.paths ?? {})) {
    const getOp = pathItem.get;
    if (!getOp || !isOperation(getOp)) continue;
    const schema = successSchema(getOp, spec);
    if (schema?.type !== "object" || !schema.properties) continue;

    const arrayKeys = Object.entries(schema.properties)
      .filter(([, prop]) => {
        const resolved = prop.$ref ? resolveSchema(prop, spec) : prop;
        return resolved?.type === "array";
      })
      .map(([key]) => key);

    if (arrayKeys.length === 1) {
      listResponses++;
      counts.set(arrayKeys[0]!, (counts.get(arrayKeys[0]!) ?? 0) + 1);
    }
  }

  if (counts.size === 0) return null;

  const ranked = [...counts.entries()].sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    const ai = ENVELOPE_PREFERENCE.indexOf(a[0]);
    const bi = ENVELOPE_PREFERENCE.indexOf(b[0]);
    return (
      (ai === -1 ? ENVELOPE_PREFERENCE.length : ai) - (bi === -1 ? ENVELOPE_PREFERENCE.length : bi)
    );
  });

  const [key, count] = ranked[0]!;
  // Demand a repeated pattern unless the spec only has one list response at all.
  if (count < 2 && listResponses > 1) return null;
  return key;
}

export function parseOpenAPI(doc: unknown): ParsedSpec {
  const spec = doc as OpenAPIDoc;

  const title = spec.info?.title ?? "Unknown";

  let baseUrl = "https://api.example.com";
  let baseUrlSource: ParsedSpec["baseUrlSource"] = "default";
  if (spec.servers?.[0]?.url) {
    baseUrl = spec.servers[0].url;
    baseUrlSource = "spec";
  } else if (spec.host) {
    baseUrl = `https://${spec.host}${spec.basePath ?? ""}`;
    baseUrlSource = "spec";
  }

  let authType: ParsedSpec["authType"] = "apiKey";
  let authSource: ParsedSpec["authSource"] = "default";
  let authKeyName = "apiKey";
  let authIn: ParsedSpec["authIn"] = "header";
  const schemes = spec.components?.securitySchemes ?? spec.securityDefinitions ?? {};
  for (const scheme of Object.values(schemes)) {
    if (scheme.type === "http" && scheme.scheme === "basic") {
      authType = "basic";
      authSource = "spec";
      break;
    }
    if (scheme.type === "http" && scheme.scheme === "bearer") {
      authType = "bearer";
      authSource = "spec";
      break;
    }
    if (scheme.type === "oauth2") {
      authType = "oauth2";
      authSource = "spec";
      break;
    }
    if (scheme.type === "apiKey") {
      authType = "apiKey";
      authSource = "spec";
      authKeyName = scheme.name ?? "x-api-key";
      authIn = scheme.in === "query" ? "query" : "header";
    }
  }

  const endpoints: ParsedSpec["endpoints"] = [];
  for (const [path, methods] of Object.entries(spec.paths ?? {})) {
    for (const [method, op] of Object.entries(methods)) {
      if (HTTP_METHODS.has(method) && isOperation(op)) {
        const ep: { method: string; path: string; operationId?: string } = {
          method: method.toUpperCase(),
          path,
        };
        if (op.operationId !== undefined) ep.operationId = op.operationId;
        endpoints.push(ep);
      }
    }
  }

  return {
    title,
    baseUrl,
    baseUrlSource,
    authType,
    authSource,
    authKeyName,
    authIn,
    endpoints,
    pagination: detectPagination(spec),
    documentedStatuses: collectDocumentedStatuses(spec),
    envelopeKey: detectEnvelopeKey(spec),
  };
}
