import { randomUUID } from "node:crypto";
import type {
  LanguageModelV3,
  LanguageModelV3GenerateResult,
  LanguageModelV3Middleware,
  LanguageModelV3StreamResult,
} from "@ai-sdk/provider";
import type {
  CircuitBreakerConfig,
  MeridianErrorCategory,
  ObservabilityAdapter,
  RetryConfig,
} from "../core/types.js";
import { IdempotencyLevel, MeridianError } from "../core/types.js";
import { ProviderCircuitBreaker } from "../resilience/circuit-breaker.js";
import { IdempotencyResolver } from "../resilience/idempotency.js";
import { RetryStrategy } from "../resilience/retry.js";
import { type ClassifiedError, classifyAiError } from "./errors.js";

export type { ClassifiedError } from "./errors.js";

export interface MeridianAiOptions {
  /** Models tried in order if the primary fails. Each gets its own retry + circuit breaker. */
  fallbacks?: LanguageModelV3[];
  /** Retry config shared by every model (primary and fallbacks). Defaults to no retries, matching the core SDK. */
  retry?: Partial<RetryConfig>;
  /** Circuit breaker config shared by every model. */
  circuitBreaker?: Partial<CircuitBreakerConfig>;
  /** Same ObservabilityAdapter interface as the core SDK — console, OTel, AnalyticsCollector, ReliabilityRecorder all work unmodified. */
  observability?: ObservabilityAdapter[];
  /** Override how a thrown error maps to a retry/failover decision. Defaults to classifyAiError. */
  classifyError?: (error: unknown) => ClassifiedError | Promise<ClassifiedError>;
  /**
   * Error categories that move to the next fallback model. Defaults to
   * `["rate_limit", "network", "provider"]` — the same default as the core
   * SDK's `ServiceClient` (src/services/service-client.ts). `auth` and
   * `validation` are excluded by default: a bad API key or a malformed
   * request is your config, not an outage, so failing over would silently
   * mask it instead of surfacing it.
   */
  failoverOn?: MeridianErrorCategory[];
}

type Op = "generate" | "stream";

function modelKey(model: LanguageModelV3): string {
  return `${model.provider}:${model.modelId}`;
}

function safelyBroadcast(
  adapters: ObservabilityAdapter[],
  fn: (a: ObservabilityAdapter) => void,
): void {
  for (const a of adapters) {
    try {
      fn(a);
    } catch {
      // Observability must never break the request path.
    }
  }
}

/**
 * AI SDK middleware that wraps language-model calls with Meridian's retry,
 * circuit-breaker, failover, and observability primitives.
 *
 * Unlike Meridian's HTTP layer, no request/response translation is needed:
 * the AI SDK already normalizes every provider into one doGenerate/doStream
 * interface, so wrapping it is enough.
 *
 * Generation calls default to safe-to-retry (IdempotencyLevel.SAFE): unlike a
 * payments POST, providers bill only for completions actually returned, so a
 * call that errors before producing output can't be double-charged by
 * retrying it (same model) or failing over to a fallback model.
 *
 * Streaming is the one exception to "no translation needed": only the
 * doStream() promise (connection setup) is retried/failed over. Once it
 * resolves, the returned stream is passed through untouched — Meridian never
 * inspects or retries mid-stream content, so an error partway through a
 * stream surfaces to the caller exactly as the provider produced it. See
 * docs/ai-sdk.md for why.
 */
export function meridianReliability(opts: MeridianAiOptions = {}): LanguageModelV3Middleware {
  const idempotencyResolver = new IdempotencyResolver({});
  const entries = new Map<string, { retry: RetryStrategy; breaker: ProviderCircuitBreaker }>();
  const observability = opts.observability ?? [];
  const failoverOn = new Set<MeridianErrorCategory>(
    opts.failoverOn ?? ["rate_limit", "network", "provider"],
  );

  function entryFor(model: LanguageModelV3): {
    retry: RetryStrategy;
    breaker: ProviderCircuitBreaker;
  } {
    const key = modelKey(model);
    let entry = entries.get(key);
    if (!entry) {
      entry = {
        retry: new RetryStrategy(opts.retry ?? {}, idempotencyResolver),
        breaker: new ProviderCircuitBreaker(key, opts.circuitBreaker),
      };
      entries.set(key, entry);
    }
    return entry;
  }

  async function classify(error: unknown): Promise<ClassifiedError> {
    return opts.classifyError ? await opts.classifyError(error) : await classifyAiError(error);
  }

  /** Runs one model attempt through circuit-breaker -> retry, with observability. */
  async function attempt<T>(
    model: LanguageModelV3,
    op: Op,
    call: () => PromiseLike<T>,
  ): Promise<T> {
    const { retry, breaker } = entryFor(model);
    const provider = model.provider;
    const endpoint = `${model.modelId}:${op}`;

    return breaker.execute(() =>
      retry.execute(
        async () => {
          const requestId = randomUUID();
          const start = performance.now();
          safelyBroadcast(observability, (a) =>
            a.logRequest({
              provider,
              endpoint,
              method: "POST",
              requestId,
              timestamp: new Date(),
              options: {},
            }),
          );
          try {
            const result = await call();
            safelyBroadcast(observability, (a) =>
              a.logResponse({
                provider,
                endpoint,
                method: "POST",
                requestId,
                statusCode: 200,
                duration: performance.now() - start,
                timestamp: new Date(),
              }),
            );
            return result;
          } catch (rawError) {
            const { category, retryable } = await classify(rawError);
            const meridianError = new MeridianError(
              rawError instanceof Error ? rawError.message : String(rawError),
              category,
              provider,
              retryable,
              requestId,
            );
            safelyBroadcast(observability, (a) =>
              a.logError({
                provider,
                endpoint,
                method: "POST",
                requestId,
                error: meridianError,
                duration: performance.now() - start,
                timestamp: new Date(),
              }),
            );
            throw meridianError;
          }
        },
        IdempotencyLevel.SAFE,
        false,
      ),
    );
  }

  function canFailover(error: unknown): boolean {
    return error instanceof MeridianError && failoverOn.has(error.category);
  }

  /** Tries the primary, then each fallback in order. Throws the last error if every model is exhausted. */
  async function runChain<T>(
    primaryModel: LanguageModelV3,
    primaryCall: () => PromiseLike<T>,
    op: Op,
    fallbackCall: (model: LanguageModelV3) => PromiseLike<T>,
  ): Promise<T> {
    try {
      return await attempt(primaryModel, op, primaryCall);
    } catch (primaryError) {
      if (!canFailover(primaryError)) throw primaryError;

      let lastError: unknown = primaryError;
      for (const fallback of opts.fallbacks ?? []) {
        try {
          return await attempt(fallback, op, () => fallbackCall(fallback));
        } catch (fallbackError) {
          if (!canFailover(fallbackError)) throw fallbackError;
          lastError = fallbackError;
        }
      }
      throw lastError;
    }
  }

  return {
    specificationVersion: "v3",

    async wrapGenerate({ doGenerate, params, model }): Promise<LanguageModelV3GenerateResult> {
      return runChain(model, doGenerate, "generate", (m) => m.doGenerate(params));
    },

    async wrapStream({ doStream, params, model }): Promise<LanguageModelV3StreamResult> {
      return runChain(model, doStream, "stream", (m) => m.doStream(params));
    },
  };
}
