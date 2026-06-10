/**
 * Shared helpers for the `npm run demo:*` scripts.
 *
 * These demos drive the real Meridian pipeline against deterministic
 * `MockAdapter`s (the same harness the benchmarks use) and narrate what the
 * pipeline does in real time — the same retries, failovers, and circuit
 * breaker transitions that show up in `meta.trace`, just printed as they
 * happen instead of buried in a log line.
 */

import type {
  ErrorContext,
  Metric,
  ObservabilityAdapter,
  RequestContext,
  ResponseContext,
} from "../src/core/types.js";

const supportsColor = process.stdout.isTTY && process.env.NO_COLOR === undefined;

function wrap(code: string): (s: string) => string {
  return supportsColor ? (s: string) => `\x1b[${code}m${s}\x1b[0m` : (s: string) => s;
}

export const color = {
  bold: wrap("1"),
  dim: wrap("2"),
  red: wrap("31"),
  green: wrap("32"),
  yellow: wrap("33"),
  cyan: wrap("36"),
};

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function banner(title: string): void {
  const line = "─".repeat(title.length + 4);
  console.log(color.bold(`\n┌${line}┐`));
  console.log(color.bold(`│  ${title}  │`));
  console.log(color.bold(`└${line}┘\n`));
}

export function section(title: string): void {
  console.log(`\n${color.bold(title)}`);
}

/**
 * Prints each pipeline event (one per provider attempt) as it happens —
 * this is the real `ObservabilityAdapter` interface, so the narration is
 * driven by actual retry/failover behavior, not a scripted animation.
 */
export class NarrativeObservability implements ObservabilityAdapter {
  logRequest(ctx: RequestContext): void {
    console.log(`  ${color.dim(`[${ctx.provider}]`)} → ${ctx.method} ${ctx.endpoint}`);
  }

  logResponse(ctx: ResponseContext): void {
    console.log(
      `  ${color.dim(`[${ctx.provider}]`)} ${color.green("✓")} ${ctx.statusCode} OK ${color.dim(`(${ctx.duration.toFixed(0)}ms)`)}`,
    );
  }

  logError(ctx: ErrorContext): void {
    console.log(
      `  ${color.dim(`[${ctx.provider}]`)} ${color.red("✗")} ${ctx.error.category} — ${ctx.error.message} ${color.dim(`(${ctx.duration.toFixed(2)}ms)`)}`,
    );
  }

  logWarning(_message: string): void {
    // SDK setup notices (e.g. localUnsafe in-memory state) aren't part of the
    // narrative — silenced so the demo output stays focused on the scenario.
  }

  recordMetric(_metric: Metric): void {
    // not narrated
  }
}
