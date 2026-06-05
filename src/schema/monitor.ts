import type { Schema, SchemaDrift, SchemaMetadata, SchemaStorage } from "../core/types.js";
import { DriftDetector } from "../validation/drift-detector.js";

export interface SchemaReport {
  provider: string;
  endpoints: Array<{
    endpoint: string;
    version: string;
    fieldCount: number;
    schema: Schema;
  }>;
  generatedAt: string;
}

function inferSchema(value: unknown): Schema {
  if (Array.isArray(value)) {
    return { type: "array", items: value.length > 0 ? inferSchema(value[0]) : { type: "unknown" } };
  }
  if (value !== null && typeof value === "object") {
    const props: Record<string, Schema> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      props[k] = inferSchema(v);
    }
    const required = Object.keys(value as object);
    return { type: "object", properties: props, required };
  }
  if (typeof value === "string") return { type: "string" };
  if (typeof value === "number") return { type: "number" };
  if (typeof value === "boolean") return { type: "boolean" };
  return { type: "null" };
}

export class SchemaMonitor {
  private detector = new DriftDetector();

  constructor(private storage: SchemaStorage) {}

  async snapshot(provider: string, endpoint: string, data: unknown): Promise<void> {
    const schema = inferSchema(data);
    const version = new Date().toISOString();
    await this.storage.save(provider, endpoint, schema, version);
  }

  async check(provider: string, endpoint: string, data: unknown): Promise<SchemaDrift[]> {
    const previous = await this.storage.load(provider, endpoint);
    const current = inferSchema(data);

    if (!previous) {
      await this.storage.save(provider, endpoint, current, new Date().toISOString());
      return [];
    }

    return this.detector.detect(previous, current);
  }

  async list(provider: string): Promise<SchemaMetadata[]> {
    return this.storage.list(provider);
  }

  async diff(provider: string, endpoint: string, data: unknown): Promise<SchemaDrift[]> {
    return this.check(provider, endpoint, data);
  }

  async report(provider: string): Promise<SchemaReport> {
    const metadata = await this.storage.list(provider);
    const endpoints = await Promise.all(
      metadata.map(async (m) => {
        const schema = await this.storage.load(provider, m.endpoint);
        const fieldCount =
          schema?.type === "object" ? Object.keys(schema.properties ?? {}).length : 1;
        return {
          endpoint: m.endpoint,
          version: m.version,
          fieldCount,
          schema: schema ?? { type: "unknown" as const },
        };
      }),
    );
    return { provider, endpoints, generatedAt: new Date().toISOString() };
  }

  async alert(
    provider: string,
    endpoint: string,
    data: unknown,
    callback: (drifts: SchemaDrift[], provider: string, endpoint: string) => void,
  ): Promise<SchemaDrift[]> {
    const drifts = await this.check(provider, endpoint, data);
    if (drifts.length > 0) {
      callback(drifts, provider, endpoint);
    }
    return drifts;
  }
}
