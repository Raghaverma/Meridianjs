import type { MeridianErrorCategory } from "../core/types.js";

export interface ClassifiedError {
  category: MeridianErrorCategory;
  retryable: boolean;
}

/**
 * Default error classifier for AI SDK calls. Lazily imports `ai` so the core
 * `meridianjs` package never requires it as a dependency — only consumers of
 * `meridianjs/ai` need it installed, and they already do (it's required to
 * call `wrapLanguageModel` in the first place).
 */
export async function classifyAiError(error: unknown): Promise<ClassifiedError> {
  const { APICallError } = await import("ai").catch(() => {
    throw new Error("meridianjs/ai requires the 'ai' package. Install it with: npm install ai");
  });

  if (APICallError.isInstance(error)) {
    const status = error.statusCode;
    if (status === 401 || status === 403) return { category: "auth", retryable: false };
    if (status === 429) return { category: "rate_limit", retryable: true };
    if (status !== undefined && status >= 500) return { category: "provider", retryable: true };
    return { category: "provider", retryable: error.isRetryable };
  }

  // Not an APICallError — e.g. a network failure or timeout before the
  // provider ever responded. Safe to treat as retryable.
  return { category: "network", retryable: true };
}
