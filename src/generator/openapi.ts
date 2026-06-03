interface OpenAPIDoc {
  openapi?: string;
  swagger?: string;
  info?: { title?: string };
  servers?: Array<{ url: string }>;
  host?: string;
  basePath?: string;
  paths?: Record<string, Record<string, { operationId?: string; summary?: string }>>;
  components?: {
    securitySchemes?: Record<string, { type: string; scheme?: string; in?: string; name?: string }>;
  };
  securityDefinitions?: Record<
    string,
    { type: string; scheme?: string; in?: string; name?: string }
  >;
}

export interface ParsedSpec {
  title: string;
  baseUrl: string;
  authType: "apiKey" | "bearer" | "basic" | "oauth2";
  authKeyName: string;
  endpoints: Array<{ method: string; path: string; operationId?: string }>;
}

export function parseOpenAPI(doc: unknown): ParsedSpec {
  const spec = doc as OpenAPIDoc;

  const title = spec.info?.title ?? "Unknown";

  let baseUrl = "https://api.example.com";
  if (spec.servers?.[0]?.url) {
    baseUrl = spec.servers[0].url;
  } else if (spec.host) {
    baseUrl = `https://${spec.host}${spec.basePath ?? ""}`;
  }

  let authType: ParsedSpec["authType"] = "apiKey";
  let authKeyName = "apiKey";
  const schemes = spec.components?.securitySchemes ?? spec.securityDefinitions ?? {};
  for (const scheme of Object.values(schemes)) {
    if (scheme.type === "http" && scheme.scheme === "basic") {
      authType = "basic";
      break;
    }
    if (scheme.type === "http" && scheme.scheme === "bearer") {
      authType = "bearer";
      break;
    }
    if (scheme.type === "oauth2") {
      authType = "oauth2";
      break;
    }
    if (scheme.type === "apiKey") {
      authType = "apiKey";
      authKeyName = scheme.name ?? "x-api-key";
    }
  }

  const endpoints: ParsedSpec["endpoints"] = [];
  const httpMethods = new Set(["get", "post", "put", "patch", "delete"]);
  for (const [path, methods] of Object.entries(spec.paths ?? {})) {
    for (const [method, op] of Object.entries(methods)) {
      if (httpMethods.has(method)) {
        const ep: { method: string; path: string; operationId?: string } = {
          method: method.toUpperCase(),
          path,
        };
        if (op.operationId !== undefined) ep.operationId = op.operationId;
        endpoints.push(ep);
      }
    }
  }

  return { title, baseUrl, authType, authKeyName, endpoints };
}
