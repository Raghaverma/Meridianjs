import type { RequestOptions } from "./types.js";

export interface SanitizerOptions {
  redactedKeys?: string[];
  piiRedaction?: boolean | undefined;
}

const PII_PATTERNS = {
  
  EMAIL: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
  
  PHONE: /(\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g,
  
  SSN: /\b\d{3}-\d{2}-\d{4}\b/g,
  
  CREDIT_CARD: /\b(?:\d[ -]*?){13,16}\b/g,
};

const DEFAULT_REDACTED = [
  "authorization",
  "cookie",
  "token",
  "apikey",
  "api_key",
  "body",
];

export function sanitizeRequestOptions(options: RequestOptions | undefined, opts?: SanitizerOptions): RequestOptions {
  const redacted = (opts?.redactedKeys ?? DEFAULT_REDACTED).map(k => k.toLowerCase());
  const input = options ?? {};

  const sanitized: RequestOptions = { ...input };

  
  if (sanitized.headers) {
    const headersCopy: Record<string, string> = {};
    for (const [k, v] of Object.entries(sanitized.headers)) {
      const lower = k.toLowerCase().replace(/[-_]/g, ""); 
      const lowerValue = String(v).toLowerCase();
      
      if (redacted.some(r => {
        const normalizedR = r.replace(/[-_]/g, "");
        return lower.includes(normalizedR) || lowerValue.includes(r);
      })) {
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
      
      if (redacted.some(r => {
        const normalizedR = r.replace(/[-_]/g, "");
        return lower.includes(normalizedR) || lowerValue.includes(r);
      })) {
        queryCopy[k] = "[REDACTED]";
      } else {
        queryCopy[k] = v;
      }
    }
    sanitized.query = queryCopy;
  }

  
  if (sanitized.body !== undefined) {
    
    if (redacted.includes("body") && !opts?.piiRedaction) {
      sanitized.body = "[REDACTED]";
    } else if (opts?.piiRedaction && typeof sanitized.body === "string") {
      
      let newBody = sanitized.body;
      for (const pattern of Object.values(PII_PATTERNS)) {
        newBody = newBody.replace(pattern, "[PII-REDACTED]");
      }
      sanitized.body = newBody;
    } else if (opts?.piiRedaction && typeof sanitized.body === "object" && sanitized.body !== null) {
      
      sanitized.body = sanitizeValue(sanitized.body);
    }
  }

  return sanitized;
}

function sanitizeValue(val: any): any {
  if (typeof val === "string") {
    let newVal = val;
    for (const pattern of Object.values(PII_PATTERNS)) {
      newVal = newVal.replace(pattern, "[PII-REDACTED]");
    }
    return newVal;
  }
  if (Array.isArray(val)) {
    return val.map(sanitizeValue);
  }
  if (typeof val === "object" && val !== null) {
    const copy: Record<string, any> = {};
    for (const [k, v] of Object.entries(val)) {
      copy[k] = sanitizeValue(v);
    }
    return copy;
  }
  return val;
}
