import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { listMigrationProviders, MIGRATIONS, type MigrationMapping } from "./mappings.js";

export type FindingKind = "import" | "instantiation" | "method-call" | "http-call";

export interface MigrationFinding {
  /** Path relative to the scanned root. */
  file: string;
  /** 1-based line number. */
  line: number;
  /** The matched source line, trimmed. */
  snippet: string;
  kind: FindingKind;
  detail: string;
  /** Suggested Meridian replacement, when one maps. */
  suggestion?: string;
  /** "clean" — mechanical swap; "manual" — needs a human decision. */
  confidence: "clean" | "manual";
}

export interface MigrationReport {
  provider: string;
  root: string;
  scannedFiles: number;
  findings: MigrationFinding[];
  cleanCount: number;
  manualCount: number;
  filesAffected: number;
  configSnippet: string;
}

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);
const SKIPPED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".nuxt",
  ".output",
  "vendor",
]);

function extensionOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i === -1 ? "" : name.slice(i);
}

async function* walk(dir: string): AsyncGenerator<string> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
        yield* walk(join(dir, entry.name));
      }
    } else if (entry.isFile() && SOURCE_EXTENSIONS.has(extensionOf(entry.name))) {
      yield join(dir, entry.name);
    }
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function scanLine(
  line: string,
  mapping: MigrationMapping,
): Array<Omit<MigrationFinding, "file" | "line" | "snippet">> {
  const found: Array<Omit<MigrationFinding, "file" | "line" | "snippet">> = [];
  const trimmed = line.trim();
  if (trimmed.startsWith("//") || trimmed.startsWith("*")) return found;

  for (const pkg of mapping.packages) {
    const esc = escapeRegExp(pkg);
    const importPattern = new RegExp(
      `(from\\s+["'\`]${esc}["'\`]|require\\s*\\(\\s*["'\`]${esc}["'\`]\\s*\\)|import\\s*\\(\\s*["'\`]${esc}["'\`]\\s*\\))`,
    );
    if (importPattern.test(line)) {
      found.push({
        kind: "import",
        detail: `imports the ${pkg} SDK directly`,
        confidence: "manual",
        suggestion: `import { Meridian } from "meridianjs" — remove "${pkg}" once call sites are migrated`,
      });
    }
  }

  for (const ctor of mapping.constructors) {
    if (new RegExp(`\\bnew\\s+${escapeRegExp(ctor)}\\s*\\(`).test(line)) {
      found.push({
        kind: "instantiation",
        detail: `constructs a ${ctor} client directly`,
        confidence: "manual",
        suggestion: `await Meridian.create({ providers: { ${mapping.provider}: { … } } }) — create once, share via meridian.${mapping.provider}`,
      });
    }
  }

  for (const method of mapping.methods) {
    if (method.pattern.test(line)) {
      const finding: Omit<MigrationFinding, "file" | "line" | "snippet"> = {
        kind: "method-call",
        detail: method.manual ?? "maps directly to a Meridian call",
        confidence: method.manual ? "manual" : "clean",
        suggestion: method.meridian,
      };
      found.push(finding);
    }
  }

  for (const host of mapping.apiHosts) {
    if (line.includes(host)) {
      found.push({
        kind: "http-call",
        detail: `hand-rolled HTTP call to ${host} (no retries, no breaker, no normalization)`,
        confidence: "manual",
        suggestion: `route through meridian.${mapping.provider}.<method>("<path>") to gain the reliability layer`,
      });
    }
  }

  return found;
}

export async function scanForMigration(provider: string, root = "."): Promise<MigrationReport> {
  const mapping = MIGRATIONS[provider.toLowerCase()];
  if (!mapping) {
    throw new Error(
      `No migration mapping for "${provider}". Supported: ${listMigrationProviders().join(", ")}.`,
    );
  }

  const findings: MigrationFinding[] = [];
  let scannedFiles = 0;

  for await (const file of walk(root)) {
    scannedFiles++;
    let content: string;
    try {
      content = await readFile(file, "utf-8");
    } catch {
      continue;
    }
    // Cheap pre-filter before line-by-line work.
    const mentions =
      mapping.packages.some((p) => content.includes(p)) ||
      mapping.constructors.some((c) => content.includes(c)) ||
      mapping.apiHosts.some((h) => content.includes(h)) ||
      mapping.methods.some((m) => m.pattern.test(content));
    if (!mentions) continue;

    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      for (const partial of scanLine(lines[i]!, mapping)) {
        findings.push({
          file: relative(root, file) || file,
          line: i + 1,
          snippet: lines[i]!.trim().slice(0, 160),
          ...partial,
        });
      }
    }
  }

  const cleanCount = findings.filter((f) => f.confidence === "clean").length;
  return {
    provider: mapping.provider,
    root,
    scannedFiles,
    findings,
    cleanCount,
    manualCount: findings.length - cleanCount,
    filesAffected: new Set(findings.map((f) => f.file)).size,
    configSnippet: mapping.configSnippet,
  };
}

/** Renders the report for the CLI. Nothing is rewritten — suggestions only. */
export function formatMigrationReport(report: MigrationReport): string {
  const lines: string[] = [];
  const { findings } = report;

  lines.push(
    `Migration scan: ${report.provider} (${report.scannedFiles} files scanned under ${report.root})`,
    "",
  );

  if (findings.length === 0) {
    lines.push(`No direct ${report.provider} usage found — nothing to migrate.`);
    return lines.join("\n");
  }

  const byFile = new Map<string, MigrationFinding[]>();
  for (const f of findings) {
    const list = byFile.get(f.file) ?? [];
    list.push(f);
    byFile.set(f.file, list);
  }

  for (const [file, fileFindings] of byFile) {
    lines.push(`${file}`);
    for (const f of fileFindings) {
      const marker = f.confidence === "clean" ? "✓" : "!";
      lines.push(`  ${marker} L${f.line} [${f.kind}] ${f.snippet}`);
      lines.push(`      ${f.detail}`);
      if (f.suggestion) lines.push(`      → ${f.suggestion}`);
    }
    lines.push("");
  }

  lines.push(
    "Summary",
    `  ${findings.length} usages across ${report.filesAffected} files`,
    `  ✓ ${report.cleanCount} map cleanly to Meridian calls`,
    `  ! ${report.manualCount} need manual attention`,
    "",
    "Suggested provider config:",
    "",
    ...report.configSnippet.split("\n").map((l) => `  ${l}`),
    "",
    "No files were modified. Apply the suggestions above, then remove the direct SDK dependency.",
  );

  return lines.join("\n");
}
