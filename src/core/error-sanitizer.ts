

import { MeridianError, type MeridianErrorCategory } from "./types.js";


const SENSITIVE_METADATA_KEYS: readonly string[] = [
  "password",
  "secret",
  "token",
  "apiKey",
  "api_key",
  "authorization",
  "cookie",
  "session",
  "credentials",
  "privateKey",
  "private_key",
  "access_token",
  "refresh_token",
] as const;


function sanitizeErrorMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  const lowerSensitiveKeys = SENSITIVE_METADATA_KEYS.map((k) => k.toLowerCase());

  for (const [key, value] of Object.entries(metadata)) {
    const lowerKey = key.toLowerCase();

    
    if (lowerSensitiveKeys.some((sensitiveKey) => lowerKey.includes(sensitiveKey))) {
      sanitized[key] = "[REDACTED]";
      continue;
    }

    
    if (value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date)) {
      sanitized[key] = sanitizeErrorMetadata(value as Record<string, unknown>);
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}


const VALID_CATEGORIES: readonly MeridianErrorCategory[] = [
  "auth",
  "rate_limit",
  "network",
  "provider",
  "validation",
] as const;



function isValidCategory(category: unknown): category is MeridianErrorCategory {
  return typeof category === "string" && VALID_CATEGORIES.includes(category as MeridianErrorCategory);
}


function inferCategory(error: unknown): MeridianErrorCategory {
  if (error && typeof error === "object") {
    const err = error as Record<string, unknown>;

    
    if (typeof err.status === "number") {
      const status = err.status;
      if (status === 401 || status === 403) return "auth";
      if (status === 429) return "rate_limit";
      if (status >= 500) return "provider";
      if (status >= 400) return "validation";
    }

    
    if (typeof err.message === "string") {
      const msg = err.message.toLowerCase();
      if (msg.includes("timeout") || msg.includes("econnreset") || msg.includes("enotfound")) {
        return "network";
      }
      if (msg.includes("unauthorized") || msg.includes("forbidden") || msg.includes("auth")) {
        return "auth";
      }
      if (msg.includes("rate limit") || msg.includes("too many requests")) {
        return "rate_limit";
      }
    }
  }

  
  return "provider";
}


function inferRetryable(category: MeridianErrorCategory, error: unknown): boolean {
  
  if (category === "auth") return false;

  
  if (category === "rate_limit") return true;

  
  if (category === "network") return true;

  
  if (category === "provider") {
    
    if (error && typeof error === "object" && "retryable" in error) {
      return Boolean((error as { retryable: unknown }).retryable);
    }
    return true; 
  }

  
  return false;
}



export function sanitizeMeridianError(
  error: unknown,
  expectedProvider: string,
  requestId: string = ""
): MeridianError {

  if (!error) {
    return createFallbackError("Unknown error", expectedProvider, requestId);
  }


  if (typeof error !== "object") {
    return createFallbackError(String(error), expectedProvider, requestId);
  }

  const err = error as Record<string, unknown>;


  const message = typeof err.message === "string" && err.message.length > 0
    ? err.message
    : "Unknown error";


  const rawCategory = err.category;
  const category: MeridianErrorCategory = isValidCategory(rawCategory)
    ? rawCategory
    : inferCategory(error);


  const rawRetryable = err.retryable;
  const retryable: boolean = typeof rawRetryable === "boolean"
    ? rawRetryable
    : inferRetryable(category, error);


  const provider = expectedProvider;


  const errorRequestId = typeof err.requestId === "string" && err.requestId.length > 0
    ? err.requestId
    : requestId;


  const status = typeof err.status === "number" ? err.status : undefined;





  const rawMetadata = err.metadata as Record<string, unknown> | undefined;
  const metadata = rawMetadata ? sanitizeErrorMetadata(rawMetadata) : undefined;


  let retryAfter: Date | undefined;
  if (err.retryAfter instanceof Date) {
    retryAfter = err.retryAfter;
  } else if (typeof err.retryAfter === "number") {
    retryAfter = new Date(Date.now() + err.retryAfter * 1000);
  } else if (typeof err.retryAfter === "string") {
    const parsed = Date.parse(err.retryAfter);
    if (!isNaN(parsed)) {
      retryAfter = new Date(parsed);
    }
  }


  const sanitized = new MeridianError(
    message,
    category,
    provider,
    retryable,
    errorRequestId,
    metadata,
    retryAfter,
    status
  );

  return sanitized;
}


function createFallbackError(message: string, provider: string, requestId: string = ""): MeridianError {
  return new MeridianError(
    message,
    "provider",
    provider,
    false,
    requestId
  );
}
