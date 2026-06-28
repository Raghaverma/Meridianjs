import { CircuitState } from "../core/types.js";
import { SDK_VERSION } from "../core/version.generated.js";
import { ContractRegistry } from "../infrastructure/registry/contract-registry.js";
import { summarizeSession } from "../infrastructure/replay/replayer.js";
import { ReliabilityStore } from "../infrastructure/replay/store.js";

/**
 * `meridian doctor` — a read-only, audit-ranked health check.
 *
 * It reads only what already lives on disk inside `.meridian/` (the contract
 * registry and reliability recordings) plus the runtime environment, and turns
 * it into a single ranked list of findings. No network calls, no live Meridian
 * instance required — the same disk-only contract as `meridian studio`.
 */

export type DoctorSeverity = "critical" | "warning" | "info" | "ok";
export type DoctorArea = "environment" | "registry" | "recordings";

export interface DoctorFinding {
  severity: DoctorSeverity;
  area: DoctorArea;
  title: string;
  /** Supporting context for the finding. */
  detail?: string;
  /** A concrete next step the user can take. */
  remedy?: string;
}

export interface DoctorReport {
  generatedAt: string;
  /** Findings, most severe first (critical → ok). */
  findings: DoctorFinding[];
  counts: Record<DoctorSeverity, number>;
  /** True when there are no critical findings. */
  healthy: boolean;
}

export interface DoctorOptions {
  /** Registry location; defaults to `.meridian/registry`. */
  registryDir?: string;
  /** Recordings location; defaults to `.meridian/recordings`. */
  recordingsDir?: string;
  /** Probe optional peer dependencies (ai, gRPC, OTel). Default true. */
  checkIntegrations?: boolean;
  /** Clock injection point for staleness math (tests). Default now. */
  now?: Date;
}

// Lower rank = more severe = sorted first.
const SEVERITY_RANK: Record<DoctorSeverity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
  ok: 3,
};

const MIN_NODE_MAJOR = 20;
/** A schema unre-verified for this long is worth a nudge — upstreams drift silently. */
const STALE_SCHEMA_DAYS = 90;
/** A recorded session whose worst call crossed this is flagged as a latency spike. */
const HIGH_LATENCY_MS = 5000;
/** Half a session's calls failing is an outage, not noise. */
const HIGH_FAILURE_RATE = 0.5;
/** More than 2 retries per request on average is a retry storm. */
const RETRY_STORM_RATIO = 2;

/** Optional peer deps and the feature each unlocks. */
const OPTIONAL_INTEGRATIONS: ReadonlyArray<readonly [spec: string, feature: string]> = [
  ["ai", "AI SDK reliability middleware (meridianjs/ai)"],
  ["@grpc/grpc-js", "gRPC Boundary Proxy (polyglot clients)"],
  ["@opentelemetry/api", "OpenTelemetry auto-instrumentation"],
];

async function canImport(spec: string): Promise<boolean> {
  try {
    await import(spec);
    return true;
  } catch {
    return false;
  }
}

function daysSince(iso: string, now: Date): number | null {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return null;
  return Math.floor((now.getTime() - then) / 86_400_000);
}

/** Runs every check and returns the ranked report. Pure read; never writes. */
export async function diagnose(options: DoctorOptions = {}): Promise<DoctorReport> {
  const now = options.now ?? new Date();
  const checkIntegrations = options.checkIntegrations ?? true;
  const findings: DoctorFinding[] = [];

  // ── Environment ────────────────────────────────────────────────────────
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "", 10);
  if (Number.isFinite(nodeMajor) && nodeMajor < MIN_NODE_MAJOR) {
    findings.push({
      severity: "critical",
      area: "environment",
      title: `Node ${process.versions.node} is below the supported floor (>= ${MIN_NODE_MAJOR})`,
      detail: "Meridian relies on Node 20+ runtime APIs; older versions may fail at runtime.",
      remedy: `Upgrade to Node ${MIN_NODE_MAJOR} or newer.`,
    });
  } else {
    findings.push({
      severity: "ok",
      area: "environment",
      title: `Node ${process.versions.node} · Meridian v${SDK_VERSION}`,
    });
  }

  if (checkIntegrations) {
    for (const [spec, feature] of OPTIONAL_INTEGRATIONS) {
      const available = await canImport(spec);
      findings.push(
        available
          ? { severity: "ok", area: "environment", title: `${feature} ready` }
          : {
              severity: "info",
              area: "environment",
              title: `${feature} unavailable`,
              detail: `Optional peer dependency "${spec}" is not installed.`,
              remedy: `npm install ${spec}`,
            },
      );
    }
  }

  // ── Contract registry ──────────────────────────────────────────────────
  const registry = new ContractRegistry(options.registryDir);
  const providers = await registry.listProviders();
  if (providers.length === 0) {
    findings.push({
      severity: "info",
      area: "registry",
      title: "No contracts registered",
      detail: "No provider response schemas are being tracked for drift.",
      remedy:
        "Capture a baseline with `meridian registry snapshot --provider <name> --endpoint <path> --data sample.json`.",
    });
  } else {
    let endpointCount = 0;
    let breakingEndpoints = 0;
    for (const provider of providers) {
      const report = await registry.report(provider);
      for (const e of report.endpoints) {
        endpointCount++;
        if (e.breakingEvents > 0) {
          breakingEndpoints++;
          findings.push({
            severity: "warning",
            area: "registry",
            title: `${provider} ${e.endpoint}: ${e.breakingEvents} breaking schema change(s) recorded`,
            detail: `${e.driftEvents} drift event(s) total, now at v${e.latestVersion}.`,
            remedy: `Review the history with \`meridian registry report --provider ${provider}\`.`,
          });
        } else if (e.driftEvents > 0) {
          findings.push({
            severity: "info",
            area: "registry",
            title: `${provider} ${e.endpoint}: ${e.driftEvents} non-breaking drift event(s)`,
            detail: `Now at v${e.latestVersion}.`,
          });
        }
        const age = daysSince(e.lastCapturedAt, now);
        if (age !== null && age > STALE_SCHEMA_DAYS) {
          findings.push({
            severity: "warning",
            area: "registry",
            title: `${provider} ${e.endpoint}: schema not verified in ${age} days`,
            detail: `Last captured ${e.lastCapturedAt}.`,
            remedy: "Re-check against a live sample with `meridian registry check`.",
          });
        }
      }
    }
    findings.push({
      severity: "ok",
      area: "registry",
      title: `${providers.length} provider(s), ${endpointCount} endpoint(s) tracked`,
      detail:
        breakingEndpoints === 0
          ? "No breaking changes in history."
          : `${breakingEndpoints} endpoint(s) carry breaking history.`,
    });
  }

  // ── Reliability recordings ─────────────────────────────────────────────
  const store = new ReliabilityStore(options.recordingsDir);
  const sessions = await store.list();
  if (sessions.length === 0) {
    findings.push({
      severity: "info",
      area: "recordings",
      title: "No reliability recordings",
      detail: "No captured sessions to analyze for outages or breaker activity.",
      remedy: "Capture one with `meridian.startRecording(<name>)` while traffic flows.",
    });
  } else {
    for (const name of sessions) {
      let summary: ReturnType<typeof summarizeSession>;
      try {
        summary = summarizeSession(await store.load(name));
      } catch (err) {
        findings.push({
          severity: "warning",
          area: "recordings",
          title: `Recording "${name}" could not be read`,
          detail: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      const opened = summary.breakerTransitions.filter((t) => t.to === CircuitState.OPEN);
      if (opened.length > 0) {
        const who = [...new Set(opened.map((t) => t.provider))].join(", ");
        findings.push({
          severity: "warning",
          area: "recordings",
          title: `"${name}": circuit breaker opened for ${who}`,
          detail: `${opened.length} OPEN transition(s) — the provider failed enough to be shed.`,
        });
      }

      const failureRate = summary.requests > 0 ? summary.failed / summary.requests : 0;
      if (summary.requests > 0 && failureRate >= HIGH_FAILURE_RATE) {
        findings.push({
          severity: "warning",
          area: "recordings",
          title: `"${name}": ${Math.round(failureRate * 100)}% of requests failed`,
          detail: `${summary.failed}/${summary.requests} requests errored.`,
        });
      }

      if (summary.requests > 0 && summary.totalRetries / summary.requests >= RETRY_STORM_RATIO) {
        findings.push({
          severity: "warning",
          area: "recordings",
          title: `"${name}": retry storm — ${summary.totalRetries} retries over ${summary.requests} requests`,
        });
      }

      if (summary.latency.maxMs >= HIGH_LATENCY_MS) {
        findings.push({
          severity: "warning",
          area: "recordings",
          title: `"${name}": peak latency ${summary.latency.maxMs}ms`,
          detail: `Average ${summary.latency.avgMs}ms across the session.`,
        });
      }

      if (summary.failovers.length > 0) {
        const hops = [...new Set(summary.failovers.map((f) => `${f.from}→${f.to}`))].join(", ");
        findings.push({
          severity: "info",
          area: "recordings",
          title: `"${name}": ${summary.failovers.length} failover(s) (${hops})`,
          detail: "Failover engaged — the recovery path was exercised.",
        });
      }
    }
    findings.push({
      severity: "ok",
      area: "recordings",
      title: `${sessions.length} recording(s) analyzed`,
    });
  }

  // Rank most-severe-first; stable sort keeps insertion order within a tier.
  findings.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);

  const counts: Record<DoctorSeverity, number> = { critical: 0, warning: 0, info: 0, ok: 0 };
  for (const f of findings) counts[f.severity]++;

  return {
    generatedAt: now.toISOString(),
    findings,
    counts,
    healthy: counts.critical === 0,
  };
}

const GLYPH: Record<DoctorSeverity, string> = {
  critical: "✗",
  warning: "⚠",
  info: "·",
  ok: "✓",
};

const AREA_LABELS: ReadonlyArray<readonly [DoctorArea, string]> = [
  ["environment", "Environment"],
  ["registry", "Contract registry"],
  ["recordings", "Reliability recordings"],
];

/** Renders the report as a sectioned, human-readable audit. */
export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [`Meridian doctor — ${report.generatedAt}`, ""];

  for (const [area, label] of AREA_LABELS) {
    const items = report.findings
      .filter((f) => f.area === area)
      .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
    if (items.length === 0) continue;
    lines.push(label);
    for (const f of items) {
      lines.push(`  ${GLYPH[f.severity]} ${f.title}`);
      if (f.detail) lines.push(`      ${f.detail}`);
      if (f.remedy) lines.push(`      → ${f.remedy}`);
    }
    lines.push("");
  }

  const { critical, warning, info } = report.counts;
  const verdict = report.healthy
    ? warning > 0
      ? "Healthy, with warnings"
      : "Healthy"
    : "Action required";
  lines.push(
    `${report.healthy ? "✓" : "✗"} ${verdict} — ${critical} critical · ${warning} warning · ${info} info`,
  );

  return lines.join("\n");
}
