import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Schema, SchemaDrift } from "../../core/types.js";
import { inferSchema } from "../schema/monitor.js";
import { DriftDetector } from "../validation/drift-detector.js";

/**
 * Default registry location inside the shared `.meridian/` directory
 * (alongside `schemas/` and `recordings/`). The registry is designed to be
 * committed to git: snapshots are versioned files, drift history is an
 * append-only log, and `check` is CI's gate against breaking upstream changes.
 */
export const DEFAULT_REGISTRY_DIR = join(".meridian", "registry");

export interface SnapshotEntry {
  provider: string;
  endpoint: string;
  version: number;
  capturedAt: string;
  checksum: string;
  schema: Schema;
}

export interface DriftEvent {
  fromVersion: number;
  toVersion: number;
  at: string;
  drifts: SchemaDrift[];
}

export interface SnapshotResult {
  provider: string;
  endpoint: string;
  version: number;
  /** False when the schema was identical to the latest snapshot (no write). */
  created: boolean;
  /** Drift against the previous version, when one existed. */
  drifts: SchemaDrift[];
}

export interface CheckResult {
  provider: string;
  endpoint: string;
  /** Version the data was checked against; null when nothing is registered yet. */
  againstVersion: number | null;
  drifts: SchemaDrift[];
  /** True when any drift is severity ERROR (removed fields, changed types). */
  breaking: boolean;
}

export interface EndpointReport {
  endpoint: string;
  versions: number;
  latestVersion: number;
  lastCapturedAt: string;
  driftEvents: number;
  breakingEvents: number;
}

export interface RegistryReport {
  provider: string;
  endpoints: EndpointReport[];
  generatedAt: string;
}

function hash(str: string): string {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h << 5) - h + str.charCodeAt(i);
    h = h & h;
  }
  return Math.abs(h).toString(36);
}

function endpointSlug(endpoint: string): string {
  const readable = endpoint.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "root";
  // Short hash disambiguates endpoints that collapse to the same readable slug.
  return `${readable}-${hash(endpoint).slice(0, 6)}`;
}

function isBreaking(drifts: SchemaDrift[]): boolean {
  return drifts.some((d) => d.severity === "ERROR");
}

export class ContractRegistry {
  private detector = new DriftDetector();

  constructor(private baseDir: string = DEFAULT_REGISTRY_DIR) {}

  private endpointDir(provider: string, endpoint: string): string {
    return join(this.baseDir, provider, endpointSlug(endpoint));
  }

  private async readSnapshot(file: string): Promise<SnapshotEntry> {
    return JSON.parse(await readFile(file, "utf-8")) as SnapshotEntry;
  }

  private async latestSnapshot(provider: string, endpoint: string): Promise<SnapshotEntry | null> {
    const dir = this.endpointDir(provider, endpoint);
    let files: string[];
    try {
      files = await readdir(dir);
    } catch (err) {
      if (err instanceof Error && "code" in err && err.code === "ENOENT") return null;
      throw err;
    }
    const versions = files
      .map((f) => /^v(\d+)\.json$/.exec(f)?.[1])
      .filter((v): v is string => v !== undefined)
      .map(Number)
      .sort((a, b) => b - a);
    if (versions.length === 0) return null;
    return this.readSnapshot(join(dir, `v${versions[0]}.json`));
  }

  private async readHistory(provider: string, endpoint: string): Promise<DriftEvent[]> {
    try {
      const raw = await readFile(
        join(this.endpointDir(provider, endpoint), "history.json"),
        "utf-8",
      );
      return JSON.parse(raw) as DriftEvent[];
    } catch (err) {
      if (err instanceof Error && "code" in err && err.code === "ENOENT") return [];
      throw err;
    }
  }

  /**
   * Registers the schema of a live response sample. Identical schemas are
   * no-ops; changed schemas write a new version and append the drift to the
   * endpoint's history.
   */
  async snapshot(provider: string, endpoint: string, data: unknown): Promise<SnapshotResult> {
    const schema = inferSchema(data);
    const checksum = hash(JSON.stringify(schema));
    const latest = await this.latestSnapshot(provider, endpoint);

    if (latest && latest.checksum === checksum) {
      return { provider, endpoint, version: latest.version, created: false, drifts: [] };
    }

    const version = (latest?.version ?? 0) + 1;
    const drifts = latest ? this.detector.detect(latest.schema, schema) : [];
    const dir = this.endpointDir(provider, endpoint);
    await mkdir(dir, { recursive: true });

    const entry: SnapshotEntry = {
      provider,
      endpoint,
      version,
      capturedAt: new Date().toISOString(),
      checksum,
      schema,
    };
    await writeFile(join(dir, `v${version}.json`), `${JSON.stringify(entry, null, 2)}\n`, "utf-8");

    if (latest) {
      const history = await this.readHistory(provider, endpoint);
      history.push({
        fromVersion: latest.version,
        toVersion: version,
        at: entry.capturedAt,
        drifts,
      });
      await writeFile(join(dir, "history.json"), `${JSON.stringify(history, null, 2)}\n`, "utf-8");
    }

    return { provider, endpoint, version, created: true, drifts };
  }

  /** Compares a live response sample against the latest snapshot. Read-only. */
  async check(provider: string, endpoint: string, data: unknown): Promise<CheckResult> {
    const latest = await this.latestSnapshot(provider, endpoint);
    if (!latest) {
      return { provider, endpoint, againstVersion: null, drifts: [], breaking: false };
    }
    const drifts = this.detector.detect(latest.schema, inferSchema(data));
    return {
      provider,
      endpoint,
      againstVersion: latest.version,
      drifts,
      breaking: isBreaking(drifts),
    };
  }

  async history(provider: string, endpoint: string): Promise<DriftEvent[]> {
    return this.readHistory(provider, endpoint);
  }

  /** Providers with at least one tracked endpoint, across the whole registry. */
  async listProviders(): Promise<string[]> {
    try {
      const entries = await readdir(this.baseDir, { withFileTypes: true });
      return entries
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();
    } catch (err) {
      if (err instanceof Error && "code" in err && err.code === "ENOENT") return [];
      throw err;
    }
  }

  /** Endpoints tracked for a provider (decoded from their latest snapshots). */
  async list(provider: string): Promise<string[]> {
    const dir = join(this.baseDir, provider);
    let slugs: string[];
    try {
      slugs = await readdir(dir);
    } catch (err) {
      if (err instanceof Error && "code" in err && err.code === "ENOENT") return [];
      throw err;
    }
    const endpoints: string[] = [];
    for (const slug of slugs) {
      try {
        const files = await readdir(join(dir, slug));
        const snapshotFile = files
          .filter((f) => /^v\d+\.json$/.test(f))
          .sort()
          .pop();
        if (snapshotFile) {
          const entry = await this.readSnapshot(join(dir, slug, snapshotFile));
          endpoints.push(entry.endpoint);
        }
      } catch {
        // Not an endpoint directory — ignore.
      }
    }
    return endpoints.sort();
  }

  async report(provider: string): Promise<RegistryReport> {
    const endpoints = await this.list(provider);
    const reports: EndpointReport[] = [];
    for (const endpoint of endpoints) {
      const latest = await this.latestSnapshot(provider, endpoint);
      if (!latest) continue;
      const history = await this.readHistory(provider, endpoint);
      reports.push({
        endpoint,
        versions: latest.version,
        latestVersion: latest.version,
        lastCapturedAt: latest.capturedAt,
        driftEvents: history.length,
        breakingEvents: history.filter((h) => isBreaking(h.drifts)).length,
      });
    }
    return { provider, endpoints: reports, generatedAt: new Date().toISOString() };
  }
}
