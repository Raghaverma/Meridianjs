/**
 * Vercel AI SDK integration: meridianReliability() is a LanguageModelV3
 * middleware (use with `wrapLanguageModel` from "ai") that adds retries,
 * circuit breaking, failover across models, and observability to language
 * model calls. See docs/ai-sdk.md.
 */

export type { ClassifiedError } from "./errors.js";
export { classifyAiError } from "./errors.js";
export type { MeridianAiOptions } from "./middleware.js";
export { meridianReliability } from "./middleware.js";
