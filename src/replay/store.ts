import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ReliabilitySession } from "./recorder.js";

/**
 * Default location for persisted reliability sessions, inside the shared
 * `.meridian/` directory (which also holds `schemas/` and `registry/`).
 * Sessions contain no request/response bodies — committing them to git is the
 * intended workflow.
 */
export const DEFAULT_RECORDINGS_DIR = join(".meridian", "recordings");

function sessionFileName(name: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) {
    throw new Error(
      `Invalid session name "${name}". Use letters, digits, ".", "_" or "-" (must not start with a separator).`,
    );
  }
  return `${name}.json`;
}

export class ReliabilityStore {
  constructor(private dir: string = DEFAULT_RECORDINGS_DIR) {}

  async save(session: ReliabilitySession): Promise<string> {
    const file = join(this.dir, sessionFileName(session.name));
    await mkdir(this.dir, { recursive: true });
    await writeFile(file, `${JSON.stringify(session, null, 2)}\n`, "utf-8");
    return file;
  }

  async load(name: string): Promise<ReliabilitySession> {
    const file = join(this.dir, sessionFileName(name));
    let raw: string;
    try {
      raw = await readFile(file, "utf-8");
    } catch (err) {
      if (err instanceof Error && "code" in err && err.code === "ENOENT") {
        const available = await this.list();
        const hint =
          available.length > 0
            ? `Available sessions: ${available.join(", ")}`
            : `No sessions recorded yet — capture one with meridian.startRecording("${name}").`;
        throw new Error(`No recording named "${name}" in ${this.dir}. ${hint}`);
      }
      throw err;
    }
    const session = JSON.parse(raw) as ReliabilitySession;
    if (session.version !== 1) {
      throw new Error(
        `Recording "${name}" uses session format v${String(session.version)}; this SDK reads v1.`,
      );
    }
    return session;
  }

  async list(): Promise<string[]> {
    try {
      const files = await readdir(this.dir);
      return files
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.slice(0, -".json".length))
        .sort();
    } catch (err) {
      if (err instanceof Error && "code" in err && err.code === "ENOENT") return [];
      throw err;
    }
  }
}
