import type { LanguageModelV3, LanguageModelV3CallOptions } from "@ai-sdk/provider";
import { APICallError } from "ai";
import { describe, expect, it, vi } from "vitest";
import { classifyAiError } from "./errors.js";
import { meridianReliability } from "./middleware.js";

const PARAMS = { prompt: [] } as unknown as LanguageModelV3CallOptions;

function fakeModel(
  provider: string,
  modelId: string,
  impl: {
    doGenerate?: ReturnType<typeof vi.fn>;
    doStream?: ReturnType<typeof vi.fn>;
  },
): LanguageModelV3 {
  return {
    specificationVersion: "v3",
    provider,
    modelId,
    supportedUrls: {},
    doGenerate: impl.doGenerate ?? vi.fn(),
    doStream: impl.doStream ?? vi.fn(),
  } as unknown as LanguageModelV3;
}

function generateResult(tag: string) {
  return {
    content: [{ type: "text", text: tag }],
    finishReason: "stop",
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  };
}

function apiError(statusCode: number, isRetryable: boolean) {
  return new APICallError({
    message: "boom",
    url: "https://example.test",
    requestBodyValues: {},
    statusCode,
    isRetryable,
  });
}

/** Calls wrapGenerate exactly the way wrapLanguageModel would, against `primary`. */
async function callGenerate(
  middleware: ReturnType<typeof meridianReliability>,
  primary: LanguageModelV3,
) {
  return middleware.wrapGenerate!({
    doGenerate: () => primary.doGenerate(PARAMS),
    doStream: () => primary.doStream(PARAMS),
    params: PARAMS,
    model: primary,
  });
}

async function callStream(
  middleware: ReturnType<typeof meridianReliability>,
  primary: LanguageModelV3,
) {
  return middleware.wrapStream!({
    doGenerate: () => primary.doGenerate(PARAMS),
    doStream: () => primary.doStream(PARAMS),
    params: PARAMS,
    model: primary,
  });
}

describe("meridianReliability — wrapGenerate", () => {
  it("retries the same model on a retryable failure, then succeeds", async () => {
    const doGenerate = vi
      .fn()
      .mockRejectedValueOnce(apiError(503, true))
      .mockRejectedValueOnce(apiError(503, true))
      .mockResolvedValueOnce(generateResult("primary"));
    const primary = fakeModel("openai", "gpt-4o", { doGenerate });

    const middleware = meridianReliability({ retry: { maxRetries: 2, baseDelay: 1, maxDelay: 2 } });
    const result = await callGenerate(middleware, primary);

    expect(doGenerate).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject(generateResult("primary"));
  });

  it("fails over to a fallback once the primary's retries are exhausted", async () => {
    const primaryDoGenerate = vi.fn().mockRejectedValue(apiError(503, true));
    const fallbackDoGenerate = vi.fn().mockResolvedValue(generateResult("fallback"));
    const primary = fakeModel("openai", "gpt-4o", { doGenerate: primaryDoGenerate });
    const fallback = fakeModel("anthropic", "claude-opus-4-5", { doGenerate: fallbackDoGenerate });

    const middleware = meridianReliability({
      fallbacks: [fallback],
      retry: { maxRetries: 1, baseDelay: 1, maxDelay: 2 },
    });
    const result = await callGenerate(middleware, primary);

    expect(primaryDoGenerate).toHaveBeenCalledTimes(2); // 1 attempt + 1 retry
    expect(fallbackDoGenerate).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject(generateResult("fallback"));
  });

  it("throws the last error when every model is exhausted", async () => {
    const primary = fakeModel("openai", "gpt-4o", {
      doGenerate: vi.fn().mockRejectedValue(apiError(503, true)),
    });
    const fallback = fakeModel("anthropic", "claude-opus-4-5", {
      doGenerate: vi.fn().mockRejectedValue(apiError(503, true)),
    });

    const middleware = meridianReliability({ fallbacks: [fallback] });
    await expect(callGenerate(middleware, primary)).rejects.toMatchObject({
      category: "provider",
      provider: "anthropic",
    });
  });

  it("does not retry or fail over an auth error by default", async () => {
    const primaryDoGenerate = vi.fn().mockRejectedValue(apiError(401, false));
    const fallbackDoGenerate = vi.fn().mockResolvedValue(generateResult("fallback"));
    const primary = fakeModel("openai", "gpt-4o", { doGenerate: primaryDoGenerate });
    const fallback = fakeModel("anthropic", "claude-opus-4-5", { doGenerate: fallbackDoGenerate });

    const middleware = meridianReliability({ fallbacks: [fallback], retry: { maxRetries: 3 } });

    // A bad API key is a config problem, not an outage — failing over would
    // silently mask it instead of surfacing it. Matches ServiceClient's
    // default failoverOn (src/services/service-client.ts:59).
    await expect(callGenerate(middleware, primary)).rejects.toMatchObject({ category: "auth" });
    expect(primaryDoGenerate).toHaveBeenCalledTimes(1);
    expect(fallbackDoGenerate).not.toHaveBeenCalled();
  });

  it("fails over on auth errors when failoverOn is widened to include it", async () => {
    const primaryDoGenerate = vi.fn().mockRejectedValue(apiError(401, false));
    const fallbackDoGenerate = vi.fn().mockResolvedValue(generateResult("fallback"));
    const primary = fakeModel("openai", "gpt-4o", { doGenerate: primaryDoGenerate });
    const fallback = fakeModel("anthropic", "claude-opus-4-5", { doGenerate: fallbackDoGenerate });

    const middleware = meridianReliability({
      fallbacks: [fallback],
      failoverOn: ["rate_limit", "network", "provider", "auth"],
    });
    const result = await callGenerate(middleware, primary);

    expect(result).toMatchObject(generateResult("fallback"));
    expect(primaryDoGenerate).toHaveBeenCalledTimes(1);
    expect(fallbackDoGenerate).toHaveBeenCalledTimes(1);
  });

  it("skips straight to the fallback once the primary's circuit breaker is open", async () => {
    const primaryDoGenerate = vi.fn().mockRejectedValue(apiError(503, true));
    const fallbackDoGenerate = vi.fn().mockResolvedValue(generateResult("fallback"));
    const primary = fakeModel("openai", "gpt-4o", { doGenerate: primaryDoGenerate });
    const fallback = fakeModel("anthropic", "claude-opus-4-5", { doGenerate: fallbackDoGenerate });

    const middleware = meridianReliability({
      fallbacks: [fallback],
      circuitBreaker: { failureThreshold: 1, volumeThreshold: 1 },
    });

    // First call trips the breaker open (and falls over to the fallback).
    await callGenerate(middleware, primary);
    expect(primaryDoGenerate).toHaveBeenCalledTimes(1);

    // Second call: breaker is open, primary must not be called again.
    await callGenerate(middleware, primary);
    expect(primaryDoGenerate).toHaveBeenCalledTimes(1);
    expect(fallbackDoGenerate).toHaveBeenCalledTimes(2);
  });
});

describe("meridianReliability — wrapStream", () => {
  it("fails over when doStream rejects before any chunk is emitted", async () => {
    const primary = fakeModel("openai", "gpt-4o", {
      doStream: vi.fn().mockRejectedValue(apiError(503, true)),
    });
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue({ type: "text-delta", id: "1", delta: "hi" });
        controller.close();
      },
    });
    const fallback = fakeModel("anthropic", "claude-opus-4-5", {
      doStream: vi.fn().mockResolvedValue({ stream }),
    });

    const middleware = meridianReliability({ fallbacks: [fallback] });
    const result = await callStream(middleware, primary);

    expect(result.stream).toBe(stream);
  });

  it("does not wrap or intercept the stream — a mid-stream error is the model's problem, not retried", async () => {
    // A stream that will error on its second read, simulating a connection
    // drop after the first chunk. doStream() itself resolves successfully —
    // that's the only thing Meridian's retry/failover ever sees here.
    const stream = new ReadableStream({
      pull(controller) {
        controller.enqueue({ type: "text-delta", id: "1", delta: "partial" });
        controller.error(new Error("connection dropped mid-stream"));
      },
    });
    const primary = fakeModel("openai", "gpt-4o", {
      doStream: vi.fn().mockResolvedValue({ stream }),
    });
    const fallback = fakeModel("anthropic", "claude-opus-4-5", { doStream: vi.fn() });

    const middleware = meridianReliability({ fallbacks: [fallback] });
    const result = await callStream(middleware, primary);

    // doStream() resolved, so no retry/failover is attempted — Meridian
    // returns the exact same stream reference it got from the model, and
    // never touches its body, by design (see docs/ai-sdk.md).
    expect(result.stream).toBe(stream);
    expect(fallback.doStream).not.toHaveBeenCalled();
  });
});

describe("classifyAiError", () => {
  it.each([
    [401, "auth", false],
    [403, "auth", false],
    [429, "rate_limit", true],
    [500, "provider", true],
    [503, "provider", true],
  ] as const)("maps statusCode %i to category %s (retryable=%s)", async (status, category, retryable) => {
    const classified = await classifyAiError(apiError(status, false));
    expect(classified).toEqual({ category, retryable });
  });

  it("treats a non-APICallError as a retryable network error", async () => {
    const classified = await classifyAiError(new Error("ECONNRESET"));
    expect(classified).toEqual({ category: "network", retryable: true });
  });

  it("falls back to the error's own isRetryable flag for other status codes", async () => {
    const classified = await classifyAiError(apiError(404, false));
    expect(classified).toEqual({ category: "provider", retryable: false });
  });
});
