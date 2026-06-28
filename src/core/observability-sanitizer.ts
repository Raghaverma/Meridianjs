import { redactSecrets } from "./secret-redactor.js";
import type { Metric } from "./types.js";

export interface ObservabilitySanitizerOptions {
  redactedKeys?: string[];
}

const DEFAULT = ["authorization", "cookie", "token", "apikey", "api_key", "body"];

function shouldRedact(key: string, redacted: string[]) {
  const lower = key.toLowerCase();
  return redacted.some((r) => lower.includes(r));
}

export function sanitizeObject(obj: unknown, opts?: ObservabilitySanitizerOptions): unknown {
  const redacted = (opts?.redactedKeys ?? DEFAULT).map((s) => s.toLowerCase());

  if (obj === null || obj === undefined) return obj;
  if (typeof obj === "string") return redactSecrets(obj);
  if (typeof obj !== "object") return obj;

  if (Array.isArray(obj)) {
    return obj.map((v) => sanitizeObject(v, opts));
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (shouldRedact(k, redacted)) {
      out[k] = "[REDACTED]";
    } else if (v && typeof v === "object") {
      out[k] = sanitizeObject(v, opts);
    } else if (typeof v === "string") {
      out[k] = redactSecrets(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function sanitizeMetric(metric: Metric, opts?: ObservabilitySanitizerOptions): Metric {
  const redacted = (opts?.redactedKeys ?? DEFAULT).map((s) => s.toLowerCase());
  const tags: Record<string, string> = {};
  for (const [k, v] of Object.entries(metric.tags)) {
    if (shouldRedact(k, redacted) || shouldRedact(v, redacted)) {
      tags[k] = "[REDACTED]";
    } else {
      tags[k] = redactSecrets(v);
    }
  }
  return { ...metric, tags };
}
