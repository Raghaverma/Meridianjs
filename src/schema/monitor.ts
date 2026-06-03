import type { Schema, SchemaDrift, SchemaMetadata, SchemaStorage } from "../core/types.js";
import { DriftDetector } from "../validation/drift-detector.js";

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
}
