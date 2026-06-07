import type { Schema } from "../core/types.js";
import type { SchemaReport } from "../schema/monitor.js";

export type HttpMethod = "get" | "post" | "put" | "patch" | "delete";

export interface ProviderSpecSource {
  /** Provider name as registered with Meridian, e.g. "stripe". */
  name: string;
  /** Provider base URL, included in the generated `servers` array when present. */
  baseUrl?: string;
  /** A schema report — typically from `meridian.schema.report(name)` — describing observed endpoints. */
  report: SchemaReport;
  /** Override the inferred HTTP method for specific endpoint paths (defaults to "get"). */
  methods?: Record<string, HttpMethod>;
}

export interface GenerateOpenApiSpecOptions {
  title?: string;
  version?: string;
  providers: ProviderSpecSource[];
}

export interface OpenApiDocument {
  openapi: string;
  info: { title: string; version: string };
  servers: Array<{ url: string; description: string }>;
  tags: Array<{ name: string }>;
  paths: Record<string, Record<string, unknown>>;
  components: { schemas: Record<string, unknown> };
}

/** Converts a Meridian-inferred {@link Schema} into an OpenAPI/JSON-Schema fragment. */
function schemaToOpenApi(schema: Schema): Record<string, unknown> {
  switch (schema.type) {
    case "object": {
      const properties: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(schema.properties ?? {})) {
        properties[key] = schemaToOpenApi(value);
      }
      const out: Record<string, unknown> = { type: "object", properties };
      if (schema.required && schema.required.length > 0) out.required = schema.required;
      return out;
    }
    case "array":
      return { type: "array", items: schema.items ? schemaToOpenApi(schema.items) : {} };
    case "string":
    case "number":
    case "boolean":
      return { type: schema.type };
    case "null":
      return { type: "string", nullable: true };
    default:
      return {};
  }
}

/** Builds a stable `operationId` from a provider name, HTTP method, and endpoint path. */
function buildOperationId(provider: string, method: string, endpoint: string): string {
  const slug = endpoint
    .replace(/[{}]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `${provider}_${method}_${slug}`;
}

function joinPath(providerName: string, endpoint: string): string {
  const trimmed = endpoint.startsWith("/") ? endpoint.slice(1) : endpoint;
  return `/${providerName}/${trimmed}`;
}

/**
 * Generates an OpenAPI 3.0 document describing the providers configured on a
 * Meridian instance and the endpoints actually observed for them — sourced
 * from {@link SchemaMonitor} reports (`meridian.schema.report(provider)`),
 * which infer JSON schemas from real response payloads.
 *
 * Because schema snapshots only record an endpoint path and its response
 * shape (not the HTTP method used to fetch it), every endpoint defaults to
 * `GET`; pass `methods` per provider to override specific paths.
 *
 * This is a documentation/integration aid — useful for generating internal
 * API references or feeding API gateway configuration — not a substitute for
 * each provider's own official OpenAPI spec.
 */
export function generateOpenApiSpec(options: GenerateOpenApiSpecOptions): OpenApiDocument {
  const paths: Record<string, Record<string, unknown>> = {};
  const servers: OpenApiDocument["servers"] = [];
  const tags: OpenApiDocument["tags"] = [];

  for (const source of options.providers) {
    tags.push({ name: source.name });
    if (source.baseUrl) {
      servers.push({ url: source.baseUrl, description: source.name });
    }

    for (const ep of source.report.endpoints) {
      const method = source.methods?.[ep.endpoint] ?? "get";
      const path = joinPath(source.name, ep.endpoint);
      const operations = (paths[path] ??= {});

      operations[method] = {
        operationId: buildOperationId(source.name, method, ep.endpoint),
        tags: [source.name],
        summary: `${source.name.toUpperCase()} ${ep.endpoint}`,
        description: `Schema inferred from observed traffic (captured ${ep.version}).`,
        responses: {
          "200": {
            description: "Successful response",
            content: {
              "application/json": {
                schema: schemaToOpenApi(ep.schema),
              },
            },
          },
        },
      };
    }
  }

  return {
    openapi: "3.0.3",
    info: {
      title: options.title ?? "Meridian Provider API",
      version: options.version ?? "1.0.0",
    },
    servers,
    tags,
    paths,
    components: { schemas: {} },
  };
}
