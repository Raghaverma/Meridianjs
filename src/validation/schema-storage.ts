import { promises as fs } from "fs";
import { join } from "path";
import type { Schema, SchemaMetadata, SchemaStorage } from "../core/types.js";

export type { SchemaStorage } from "../core/types.js";

export class FileSystemSchemaStorage implements SchemaStorage {
  private basePath: string;

  constructor(basePath = ".meridian/schemas") {
    this.basePath = basePath;
  }

  async save(provider: string, endpoint: string, schema: Schema, version: string): Promise<void> {
    const endpointHash = this.hashEndpoint(endpoint);
    const dir = join(this.basePath, provider);
    const filePath = join(dir, `${endpointHash}.json`);

    await fs.mkdir(dir, { recursive: true });

    const metadata: SchemaMetadata & { schema: Schema } = {
      provider,
      endpoint,
      version,
      checksum: this.calculateChecksum(schema),
      createdAt: new Date(),
      schema,
    };

    await fs.writeFile(filePath, JSON.stringify(metadata, null, 2), "utf-8");
  }

  async load(provider: string, endpoint: string): Promise<Schema | null> {
    const endpointHash = this.hashEndpoint(endpoint);
    const filePath = join(this.basePath, provider, `${endpointHash}.json`);

    try {
      const content = await fs.readFile(filePath, "utf-8");
      const metadata = JSON.parse(content) as SchemaMetadata & {
        schema: Schema;
      };
      return metadata.schema;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async list(provider: string): Promise<SchemaMetadata[]> {
    const dir = join(this.basePath, provider);

    try {
      const files = await fs.readdir(dir);
      const schemas: SchemaMetadata[] = [];

      for (const file of files) {
        if (file.endsWith(".json")) {
          const filePath = join(dir, file);
          const content = await fs.readFile(filePath, "utf-8");
          const metadata = JSON.parse(content) as SchemaMetadata & {
            schema: Schema;
          };
          schemas.push({
            provider: metadata.provider,
            endpoint: metadata.endpoint,
            version: metadata.version,
            checksum: metadata.checksum,
            createdAt: new Date(metadata.createdAt),
          });
        }
      }

      return schemas;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  private hashEndpoint(endpoint: string): string {
    let hash = 0;
    for (let i = 0; i < endpoint.length; i++) {
      const char = endpoint.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(36);
  }

  private calculateChecksum(schema: Schema): string {
    const str = JSON.stringify(schema);
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash;
    }
    return `sha256-${Math.abs(hash).toString(36)}`;
  }
}

export class InMemorySchemaStorage implements SchemaStorage {
  private schemas: Map<string, { schema: Schema; metadata: SchemaMetadata }> = new Map();

  async save(provider: string, endpoint: string, schema: Schema, version: string): Promise<void> {
    const key = `${provider}:${endpoint}`;
    const checksum = this.calculateChecksum(schema);

    this.schemas.set(key, {
      schema,
      metadata: {
        provider,
        endpoint,
        version,
        checksum,
        createdAt: new Date(),
      },
    });
  }

  async load(provider: string, endpoint: string): Promise<Schema | null> {
    const key = `${provider}:${endpoint}`;
    const entry = this.schemas.get(key);
    return entry?.schema ?? null;
  }

  async list(provider: string): Promise<SchemaMetadata[]> {
    const metadata: SchemaMetadata[] = [];

    for (const entry of this.schemas.values()) {
      if (entry.metadata.provider === provider) {
        metadata.push(entry.metadata);
      }
    }

    return metadata;
  }

  private calculateChecksum(schema: Schema): string {
    const str = JSON.stringify(schema);
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash;
    }
    return `sha256-${Math.abs(hash).toString(36)}`;
  }
}
