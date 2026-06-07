/**
 * Shared benchmark harness.
 *
 * The Meridian pipeline always dispatches through the global `fetch()` — there
 * is no per-adapter HTTP injection point. To exercise the full pipeline
 * (retry, circuit breaker, failover, normalization) without touching the
 * network, we install a `fetch()` shim that routes by hostname to a registered
 * `MockAdapter`. Each provider gets a distinct mock host, so multi-provider
 * scenarios (failover from openai -> anthropic, etc.) behave realistically and
 * deterministically.
 */

import type { RequestOptions } from "../src/core/types.js";
import { MockAdapter } from "../src/testing/mock-adapter.js";

export class MockNetwork {
  private routes = new Map<string, MockAdapter>();
  private realFetch: typeof fetch | null = null;

  /**
   * Register a provider-backed mock host. Returns the adapter so the caller can
   * attach handlers (`onRequest` / `simulateError` / `simulateDelay`).
   */
  register(host: string, adapter: MockAdapter = new MockAdapter(host)): MockAdapter {
    adapter.baseUrl = `https://${host}`;
    this.routes.set(host, adapter);
    return adapter;
  }

  install(): void {
    if (this.realFetch) return;
    this.realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const urlStr =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(urlStr);
      const adapter = this.routes.get(url.host);
      if (!adapter) {
        throw new TypeError(`MockNetwork: no route registered for host "${url.host}"`);
      }
      const method = (init?.method ?? "GET") as RequestOptions["method"] & string;
      // resolve() runs the registered handlers; a handler that throws (e.g.
      // simulateError) rejects this promise, which the pipeline treats as a
      // failed request — exactly the path retry/circuit-breaker/failover guard.
      const raw = await adapter.resolve(method, url.pathname, { method });
      const body = typeof raw.body === "string" ? raw.body : JSON.stringify(raw.body ?? {});
      return new Response(body, { status: raw.status, headers: raw.headers });
    }) as typeof fetch;
  }

  restore(): void {
    if (this.realFetch) {
      globalThis.fetch = this.realFetch;
      this.realFetch = null;
    }
  }
}

/** High-resolution elapsed-time helper (milliseconds, fractional). */
export function now(): number {
  const [s, ns] = process.hrtime();
  return s * 1000 + ns / 1e6;
}

/** Time a single async call, returning [result-or-error, elapsedMs, threw]. */
export async function timed<T>(
  fn: () => Promise<T>,
): Promise<{ ok: boolean; ms: number; value?: T; error?: unknown }> {
  const start = now();
  try {
    const value = await fn();
    return { ok: true, ms: now() - start, value };
  } catch (error) {
    return { ok: false, ms: now() - start, error };
  }
}

/** Run `fn` `n` times, returning how many resolved without throwing. */
export async function successCount(n: number, fn: () => Promise<unknown>): Promise<number> {
  let ok = 0;
  for (let i = 0; i < n; i++) {
    try {
      await fn();
      ok++;
    } catch {
      // counted as failure
    }
  }
  return ok;
}

export interface Column {
  header: string;
  align?: "left" | "right";
}

/** Render a Markdown table. */
export function markdownTable(columns: Column[], rows: string[][]): string {
  const head = `| ${columns.map((c) => c.header).join(" | ")} |`;
  const sep = `| ${columns.map((c) => (c.align === "right" ? "---:" : "---")).join(" | ")} |`;
  const body = rows.map((r) => `| ${r.join(" | ")} |`).join("\n");
  return `${head}\n${sep}\n${body}`;
}

/** Render the same table for the terminal (aligned, no pipes-as-borders noise). */
export function consoleTable(columns: Column[], rows: string[][]): string {
  const widths = columns.map((c, i) =>
    Math.max(c.header.length, ...rows.map((r) => (r[i] ?? "").length)),
  );
  const pad = (s: string, i: number) =>
    columns[i]?.align === "right" ? s.padStart(widths[i]!) : s.padEnd(widths[i]!);
  const line = (cells: string[]) => `  ${cells.map((c, i) => pad(c, i)).join("   ")}`;
  const header = line(columns.map((c) => c.header));
  const rule = `  ${widths.map((w) => "-".repeat(w)).join("   ")}`;
  return [header, rule, ...rows.map(line)].join("\n");
}
