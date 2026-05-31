import type { RequestOptions } from "./types.js";

export interface SanitizerOptions {
  redactedKeys?: string[];
  piiRedaction?: boolean | undefined;
  indiaMode?: boolean | undefined;
}

const PII_PATTERNS = {
  EMAIL: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
  PHONE: /(\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g,
  SSN: /\b\d{3}-\d{2}-\d{4}\b/g,
  CREDIT_CARD: /\b(?:\d[ -]*?){13,16}\b/g,
};

// India-specific PII patterns (DPDPA compliance)
// Application order within India mode: VPA, AADHAAR, PAN, then generic EMAIL/PHONE/SSN/CREDIT_CARD, then BANK_ACCOUNT
// AADHAAR before BANK_ACCOUNT ensures 12-digit Aadhaar numbers get their specific label
// VPA before generic EMAIL so handles-without-TLD are caught as VPA, not EMAIL
const INDIA_PII_PATTERNS = {
  // UPI Virtual Payment Address: user@oksbi (no dot in domain part distinguishes from email)
  UPI_VPA: /\b[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z]{2,64}\b/g,
  // Aadhaar: 12 digits optionally grouped 4-4-4 with spaces or hyphens
  AADHAAR: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g,
  // PAN: 5 uppercase letters, 4 digits, 1 uppercase letter
  PAN: /\b[A-Z]{5}[0-9]{4}[A-Z]\b/g,
  // Bank account: 9–18 digit run (applied after AADHAAR to avoid re-matching)
  BANK_ACCOUNT: /\b\d{9,18}\b/g,
};

const DEFAULT_REDACTED = ["authorization", "cookie", "token", "apikey", "api_key", "body"];

function applyPiiPatterns(text: string, indiaMode: boolean): string {
  let result = text;

  if (indiaMode) {
    // VPA first (before generic EMAIL) so UPI addresses without TLD are caught
    result = result.replace(INDIA_PII_PATTERNS.UPI_VPA, "[VPA-REDACTED]");
    // Aadhaar before bank account/credit card so 12-digit gets its specific label
    result = result.replace(INDIA_PII_PATTERNS.AADHAAR, "[AADHAAR-REDACTED]");
    result = result.replace(INDIA_PII_PATTERNS.PAN, "[PAN-REDACTED]");
    // Bank account before generic CREDIT_CARD so long digit runs get their specific label
    result = result.replace(INDIA_PII_PATTERNS.BANK_ACCOUNT, "[ACCOUNT-REDACTED]");
  }

  // Generic PII patterns (run for both piiRedaction and indiaMode)
  result = result.replace(PII_PATTERNS.EMAIL, "[PII-REDACTED]");
  result = result.replace(PII_PATTERNS.PHONE, "[PII-REDACTED]");
  result = result.replace(PII_PATTERNS.SSN, "[PII-REDACTED]");
  result = result.replace(PII_PATTERNS.CREDIT_CARD, "[PII-REDACTED]");

  return result;
}

export function sanitizeRequestOptions(
  options: RequestOptions | undefined,
  opts?: SanitizerOptions,
): RequestOptions {
  const redacted = (opts?.redactedKeys ?? DEFAULT_REDACTED).map((k) => k.toLowerCase());
  const input = options ?? {};
  const piiRedaction = opts?.piiRedaction === true;
  const indiaMode = opts?.indiaMode === true;
  const runPatternRedaction = piiRedaction || indiaMode;

  const sanitized: RequestOptions = { ...input };

  if (sanitized.headers) {
    const headersCopy: Record<string, string> = {};
    for (const [k, v] of Object.entries(sanitized.headers)) {
      const lower = k.toLowerCase().replace(/[-_]/g, "");
      const lowerValue = String(v).toLowerCase();

      if (
        redacted.some((r) => {
          const normalizedR = r.replace(/[-_]/g, "");
          return lower.includes(normalizedR) || lowerValue.includes(r);
        })
      ) {
        headersCopy[k] = "[REDACTED]";
      } else {
        headersCopy[k] = v;
      }
    }
    sanitized.headers = headersCopy;
  }

  if (sanitized.query) {
    const queryCopy: Record<string, string | number | boolean> = {};
    for (const [k, v] of Object.entries(sanitized.query)) {
      const lower = k.toLowerCase().replace(/[-_]/g, "");
      const lowerValue = String(v).toLowerCase();

      if (
        redacted.some((r) => {
          const normalizedR = r.replace(/[-_]/g, "");
          return lower.includes(normalizedR) || lowerValue.includes(r);
        })
      ) {
        queryCopy[k] = "[REDACTED]";
      } else {
        queryCopy[k] = v;
      }
    }
    sanitized.query = queryCopy;
  }

  if (sanitized.body !== undefined) {
    if (redacted.includes("body") && !runPatternRedaction) {
      // Non-PII path: blanket-redact body
      sanitized.body = "[REDACTED]";
    } else if (runPatternRedaction && typeof sanitized.body === "string") {
      sanitized.body = applyPiiPatterns(sanitized.body, indiaMode);
    } else if (
      runPatternRedaction &&
      typeof sanitized.body === "object" &&
      sanitized.body !== null
    ) {
      sanitized.body = sanitizeValue(sanitized.body, indiaMode);
    }
  }

  return sanitized;
}

function sanitizeValue(val: unknown, indiaMode: boolean): unknown {
  if (typeof val === "string") {
    return applyPiiPatterns(val, indiaMode);
  }
  if (Array.isArray(val)) {
    return val.map((item) => sanitizeValue(item, indiaMode));
  }
  if (typeof val === "object" && val !== null) {
    const copy: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      copy[k] = sanitizeValue(v, indiaMode);
    }
    return copy;
  }
  return val;
}
