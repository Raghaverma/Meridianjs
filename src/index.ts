import { assertValidAdapter } from "./core/adapter-validator.js";
import { sanitizeObject } from "./core/observability-sanitizer.js";
import { type PipelineConfig, RequestPipeline } from "./core/pipeline.js";
import { type StreamChunk, parseSSEStream } from "./core/streaming.js";
import type {
  AdapterInput,
  BatchRequest,
  CircuitBreakerStatus,
  MeridianConfig,
  NormalizedResponse,
  ObservabilityAdapter,
  ProviderConfig,
  RequestOptions,
} from "./core/types.js";
import { IdempotencyLevel, MeridianError } from "./core/types.js";
import type { ProviderAdapter } from "./core/types.js";
import { ConsoleObservability } from "./observability/console.js";
import { AdyenAdapter } from "./providers/adyen/adapter.js";
import { AnthropicAdapter } from "./providers/anthropic/adapter.js";
import { ApolloAdapter } from "./providers/apollo/adapter.js";
import { Auth0Adapter } from "./providers/auth0/adapter.js";
import { BilldeskAdapter } from "./providers/billdesk/adapter.js";
import { BraintreeAdapter } from "./providers/braintree/adapter.js";
import { CashfreeAdapter } from "./providers/cashfree/adapter.js";
import { CcavenueAdapter } from "./providers/ccavenue/adapter.js";
import { DatadogAdapter } from "./providers/datadog/adapter.js";
import { CheckoutAdapter } from "./providers/checkout/adapter.js";
import { CleartaxAdapter } from "./providers/cleartax/adapter.js";
import { CohereAdapter } from "./providers/cohere/adapter.js";
import { DecentroAdapter } from "./providers/decentro/adapter.js";
import { DelhiveryAdapter } from "./providers/delhivery/adapter.js";
import { DigioAdapter } from "./providers/digio/adapter.js";
import { ExotelAdapter } from "./providers/exotel/adapter.js";
import { GeminiAdapter } from "./providers/gemini/adapter.js";
import { GitHubAdapter } from "./providers/github/adapter.js";
import { GupshupAdapter } from "./providers/gupshup/adapter.js";
import { HubSpotAdapter } from "./providers/hubspot/adapter.js";
import { HyperVergeAdapter } from "./providers/hyperverge/adapter.js";
import { IdfyAdapter } from "./providers/idfy/adapter.js";
import { JuspayAdapter } from "./providers/juspay/adapter.js";
import { KarzaAdapter } from "./providers/karza/adapter.js";
import { KlarnaAdapter } from "./providers/klarna/adapter.js";
import { MailgunAdapter } from "./providers/mailgun/adapter.js";
import { MapmyindiaAdapter } from "./providers/mapmyindia/adapter.js";
import { MistralAdapter } from "./providers/mistral/adapter.js";
import { MollieAdapter } from "./providers/mollie/adapter.js";
import { Msg91Adapter } from "./providers/msg91/adapter.js";
import { OpenAIAdapter } from "./providers/openai/adapter.js";
import { PayuAdapter } from "./providers/payu/adapter.js";
import { PerfiosAdapter } from "./providers/perfios/adapter.js";
import { PhonePeAdapter } from "./providers/phonepe/adapter.js";
import { RazorpayAdapter } from "./providers/razorpay/adapter.js";
import { S3Adapter } from "./providers/s3/adapter.js";
import { SendgridAdapter } from "./providers/sendgrid/adapter.js";
import { SentryAdapter } from "./providers/sentry/adapter.js";
import { SetuAdapter } from "./providers/setu/adapter.js";
import { ShiprocketAdapter } from "./providers/shiprocket/adapter.js";
import { StripeAdapter } from "./providers/stripe/adapter.js";
import { SupabaseAdapter } from "./providers/supabase/adapter.js";
import { TwilioAdapter } from "./providers/twilio/adapter.js";
import { VonageAdapter } from "./providers/vonage/adapter.js";

import { AnalyticsCollector } from "./analytics/collector.js";
import type { CostReport } from "./analytics/collector.js";
import { PROVIDER_CAPABILITIES } from "./capabilities/registry.js";
import { CircuitState } from "./core/types.js";
import { DebugRecorder } from "./debug/recorder.js";
import { SchemaMonitor } from "./schema/monitor.js";
import { ServiceClient } from "./services/service-client.js";
import { ProviderCircuitBreaker } from "./strategies/circuit-breaker.js";
import { IdempotencyResolver } from "./strategies/idempotency.js";
import { RateLimiter } from "./strategies/rate-limit.js";
import { RetryStrategy } from "./strategies/retry.js";
import { runTransaction } from "./transactions/saga.js";
import type { TransactionResult, TransactionStep } from "./transactions/saga.js";
import { FileSystemSchemaStorage } from "./validation/schema-storage.js";

export const BUILTIN_ADAPTER_CLASSES: Record<string, new () => ProviderAdapter> = {
  github: GitHubAdapter,
  billdesk: BilldeskAdapter,
  ccavenue: CcavenueAdapter,
  datadog: DatadogAdapter,
  anthropic: AnthropicAdapter,
  openai: OpenAIAdapter,
  stripe: StripeAdapter,
  razorpay: RazorpayAdapter,
  cashfree: CashfreeAdapter,
  payu: PayuAdapter,
  juspay: JuspayAdapter,
  msg91: Msg91Adapter,
  exotel: ExotelAdapter,
  gupshup: GupshupAdapter,
  setu: SetuAdapter,
  decentro: DecentroAdapter,
  shiprocket: ShiprocketAdapter,
  delhivery: DelhiveryAdapter,
  hyperverge: HyperVergeAdapter,
  digio: DigioAdapter,
  karza: KarzaAdapter,
  idfy: IdfyAdapter,
  cleartax: CleartaxAdapter,
  mapmyindia: MapmyindiaAdapter,
  perfios: PerfiosAdapter,
  twilio: TwilioAdapter,
  sendgrid: SendgridAdapter,
  sentry: SentryAdapter,
  mailgun: MailgunAdapter,
  vonage: VonageAdapter,
  adyen: AdyenAdapter,
  gemini: GeminiAdapter,
  auth0: Auth0Adapter,
  hubspot: HubSpotAdapter,
  supabase: SupabaseAdapter,
  braintree: BraintreeAdapter,
  phonepe: PhonePeAdapter,
  checkout: CheckoutAdapter,
  cohere: CohereAdapter,
  klarna: KlarnaAdapter,
  mistral: MistralAdapter,
  mollie: MollieAdapter,
  apollo: ApolloAdapter,
  s3: S3Adapter,
};

function getBuiltinAdapter(
  name: string,
  cache: Map<string, ProviderAdapter>,
): ProviderAdapter | null {
  if (cache.has(name)) {
    return cache.get(name)!;
  }

  const AdapterClass = BUILTIN_ADAPTER_CLASSES[name];
  if (!AdapterClass) {
    return null;
  }

  const adapter = new AdapterClass();
  cache.set(name, adapter);
  return adapter;
}

export interface ProviderClient {
  get<T = unknown>(endpoint: string, options?: RequestOptions): Promise<NormalizedResponse<T>>;
  post<T = unknown>(endpoint: string, options?: RequestOptions): Promise<NormalizedResponse<T>>;
  put<T = unknown>(endpoint: string, options?: RequestOptions): Promise<NormalizedResponse<T>>;
  patch<T = unknown>(endpoint: string, options?: RequestOptions): Promise<NormalizedResponse<T>>;
  delete<T = unknown>(endpoint: string, options?: RequestOptions): Promise<NormalizedResponse<T>>;
  paginate<T = unknown>(
    endpoint: string,
    options?: RequestOptions,
  ): AsyncGenerator<NormalizedResponse<T>>;
  stream<T = unknown>(endpoint: string, options?: RequestOptions): AsyncGenerator<StreamChunk<T>>;
  batch<T = unknown>(
    requests: Array<BatchRequest>,
    concurrencyLimit?: number,
  ): Promise<Array<NormalizedResponse<T> | MeridianError>>;
}

export class Meridian {
  private config: MeridianConfig;
  private pipelines: Map<string, RequestPipeline> = new Map();
  private circuitBreakers: Map<string, ProviderCircuitBreaker> = new Map();
  private observability: ObservabilityAdapter[];
  private adapters: Map<string, ProviderAdapter> = new Map();
  private started = false;
  private adapterCache: Map<string, ProviderAdapter> = new Map();
  private serviceClients: Map<string, ServiceClient> = new Map();
  private analyticsCollector = new AnalyticsCollector();
  private debugRecorder = new DebugRecorder();
  private _schemaMonitor: SchemaMonitor | null = null;

  private constructor(config: MeridianConfig, adapters?: Map<string, ProviderAdapter>) {
    this.validateConfig(config);

    const providers =
      "providers" in config && config.providers
        ? config.providers
        : (() => {
            const knownKeys = new Set([
              "defaults",
              "schemaValidation",
              "observability",
              "observabilitySanitizer",
              "idempotency",
              "providers",
              "stateStorage",
              "localUnsafe",
              "mode",
              "compliance",
            ]);
            const providerConfigs: Record<string, ProviderConfig> = {};

            for (const [key, value] of Object.entries(config)) {
              if (!knownKeys.has(key) && value && typeof value === "object") {
                providerConfigs[key] = value as ProviderConfig;
              }
            }

            return providerConfigs;
          })();

    this.config = {
      ...config,
      providers,
    };

    if (adapters) {
      this.adapters = adapters;
    }

    if (Array.isArray(this.config.observability)) {
      this.observability = this.config.observability;
    } else if (this.config.observability) {
      this.observability = [this.config.observability];
    } else {
      this.observability = [new ConsoleObservability()];
    }

    this.observability = [...this.observability, this.analyticsCollector, this.debugRecorder];
  }

  static async create(config: MeridianConfig, adapters?: Map<string, ProviderAdapter>) {
    const b = new Meridian(config, adapters);
    await b.start();
    return b;
  }

  private emitLocalStateWarning(): void {
    const warning = [
      "[Meridian] WARNING: Using in-memory state for circuit breaker and rate limiter.",
      "This state will be lost on process restart or serverless cold start.",
      "For production serverless deployments, consider:",
      "  1. Implementing StateStorage interface with Redis/Memcached",
      "  2. Using external rate limiting (API gateway)",
      "  3. Accepting state reset as a trade-off for simplicity",
      "See: https://github.com/Raghaverma/Meridian#state-persistence",
    ].join("\n");

    const safeMetadata = sanitizeObject(
      { component: "Meridian", type: "state_warning" },
      this.config.observabilitySanitizer,
    );
    if (this.observability && this.observability.length > 0) {
      const errors: Array<{ adapter: string; error: unknown }> = [];
      for (const obs of this.observability) {
        try {
          obs.logWarning(warning, safeMetadata as Record<string, unknown>);
        } catch (error) {
          errors.push({
            adapter: obs.constructor?.name || "UnknownObservabilityAdapter",
            error,
          });
        }
      }

      if (errors.length === this.observability.length) {
        console.warn(warning);
        console.error(
          `[Meridian] All observability adapters failed for logWarning:\n${errors
            .map(
              ({ adapter, error }) =>
                `  - ${adapter}: ${error instanceof Error ? error.message : String(error)}`,
            )
            .join("\n")}`,
        );
      } else if (errors.length > 0) {
        console.error(
          `[Meridian] Some observability adapters failed for logWarning (${errors.length}/${this.observability.length}):\n${errors
            .map(
              ({ adapter, error }) =>
                `  - ${adapter}: ${error instanceof Error ? error.message : String(error)}`,
            )
            .join("\n")}`,
        );
      }
    } else {
      console.warn(warning);
    }
  }

  private validateConfig(config: MeridianConfig): void {
    const errors: string[] = [];

    if (config.defaults?.rateLimit) {
      const { tokensPerSecond, maxTokens, queueSize } = config.defaults.rateLimit;
      if (tokensPerSecond !== undefined && tokensPerSecond <= 0) {
        errors.push("defaults.rateLimit.tokensPerSecond must be positive");
      }
      if (maxTokens !== undefined && maxTokens <= 0) {
        errors.push("defaults.rateLimit.maxTokens must be positive");
      }
      if (queueSize !== undefined && queueSize <= 0) {
        errors.push("defaults.rateLimit.queueSize must be positive");
      }
    }

    if (config.defaults?.retry) {
      const { maxRetries, baseDelay, maxDelay } = config.defaults.retry;
      if (maxRetries !== undefined && maxRetries < 0) {
        errors.push("defaults.retry.maxRetries must be non-negative");
      }
      if (baseDelay !== undefined && baseDelay <= 0) {
        errors.push("defaults.retry.baseDelay must be positive");
      }
      if (maxDelay !== undefined && maxDelay <= 0) {
        errors.push("defaults.retry.maxDelay must be positive");
      }
    }

    if (config.defaults?.circuitBreaker) {
      const { failureThreshold, timeout, successThreshold } = config.defaults.circuitBreaker;
      if (failureThreshold !== undefined && failureThreshold <= 0) {
        errors.push("defaults.circuitBreaker.failureThreshold must be positive");
      }
      if (timeout !== undefined && timeout <= 0) {
        errors.push("defaults.circuitBreaker.timeout must be positive");
      }
      if (successThreshold !== undefined && successThreshold <= 0) {
        errors.push("defaults.circuitBreaker.successThreshold must be positive");
      }
    }

    if (config.defaults?.timeout !== undefined && config.defaults.timeout <= 0) {
      errors.push("defaults.timeout must be positive");
    }

    if (errors.length > 0) {
      throw new Error(`Invalid Meridian configuration:\n  - ${errors.join()}`);
    }
  }

  private async initializeProvider(
    providerName: string,
    providerConfig: ProviderConfig,
  ): Promise<void> {
    let adapter = providerConfig.adapter ?? this.adapters.get(providerName);

    if (!adapter) {
      const builtinAdapter = getBuiltinAdapter(providerName, this.adapterCache);
      if (builtinAdapter) {
        this.adapters.set(providerName, builtinAdapter);
        adapter = builtinAdapter;
      }
    }

    if (!adapter) {
      throw new Error(
        `No adapter found for provider: ${providerName}. Provide adapter in config or use registerProvider().`,
      );
    }

    await assertValidAdapter(adapter, providerName);

    this.adapters.set(providerName, adapter);

    const circuitBreakerConfig = {
      ...this.config.defaults?.circuitBreaker,
      ...providerConfig.circuitBreaker,
    };
    const circuitBreaker = new ProviderCircuitBreaker(providerName, circuitBreakerConfig);
    this.circuitBreakers.set(providerName, circuitBreaker);

    const rateLimitConfig = {
      ...this.config.defaults?.rateLimit,
      ...providerConfig.rateLimit,
    };
    const rateLimiter = new RateLimiter(rateLimitConfig);

    const retryConfig = {
      ...this.config.defaults?.retry,
      ...providerConfig.retry,
    };
    const idempotencyConfig = adapter.getIdempotencyConfig();
    const idempotencyResolver = new IdempotencyResolver(
      {
        ...idempotencyConfig,
        ...providerConfig.idempotency,
      },
      this.config.idempotency?.defaultLevel ?? IdempotencyLevel.SAFE,
    );
    const retryStrategy = new RetryStrategy(retryConfig, idempotencyResolver);

    const pipelineConfig: PipelineConfig = {
      provider: providerName,
      adapter,
      authConfig: providerConfig.auth,
      circuitBreaker,
      rateLimiter,
      retryStrategy,
      idempotencyResolver,
      observability: this.observability,
      timeout: this.config.defaults?.timeout ?? undefined,
      autoGenerateIdempotencyKeys: this.config.idempotency?.autoGenerateKeys ?? false,
      sanitizerOptions: {
        ...(this.config.observabilitySanitizer ?? {}),
        piiRedaction: this.config.compliance?.piiRedaction,
        indiaMode: this.config.compliance?.indiaMode,
      },
      compliance: this.config.compliance,
      onRawRequest: (requestId, _endpoint, _method, options) => {
        if (this.debugRecorder.enabled) {
          this.debugRecorder.recordRaw(requestId, options);
        }
      },
    };
    if (this.config.policies) pipelineConfig.policies = this.config.policies;
    const pipeline = new RequestPipeline(pipelineConfig);

    this.pipelines.set(providerName, pipeline);

    (this as any)[providerName] = this.createProviderClient(providerName);
  }

  private createProviderClient(providerName: string): ProviderClient {
    const pipeline = this.pipelines.get(providerName)!;
    const adapter = this.adapters.get(providerName);
    if (!adapter) {
      throw new Error(`Adapter not found for provider: ${providerName}`);
    }
    const meridian = this;
    const maxPages = 1000;

    const makeRequest = async <T>(
      method: string,
      endpoint: string,
      options: RequestOptions = {},
    ): Promise<NormalizedResponse<T>> => {
      meridian.ensureStarted();
      return pipeline.execute<T>(endpoint, {
        ...options,
        method: method as any,
      });
    };

    const paginate = async function* <T>(
      endpoint: string,
      options: RequestOptions = {},
    ): AsyncGenerator<NormalizedResponse<T>> {
      meridian.ensureStarted();

      const currentAdapter = meridian.adapters.get(providerName);
      if (!currentAdapter) {
        throw new Error(`Adapter not found for provider: ${providerName}`);
      }
      let currentEndpoint = endpoint;
      let currentOptions: RequestOptions = { ...options, method: "GET" };
      let pageCount = 0;
      const seenCursors = new Set<string>();

      const paginationStrategy = currentAdapter.paginationStrategy();

      while (pageCount < maxPages) {
        const response = await makeRequest<T>("GET", currentEndpoint, currentOptions);
        pageCount++;

        yield response;

        const hasNext = response.meta.pagination?.hasNext ?? false;
        const cursor = response.meta.pagination?.cursor;

        if (!hasNext || !cursor) {
          break;
        }

        if (seenCursors.has(cursor)) {
          throw new Error(
            `Pagination cycle detected: cursor "${cursor}" was encountered twice. ` +
              `This indicates a malformed pagination implementation. Stopping at page ${pageCount}.`,
          );
        }
        seenCursors.add(cursor);

        const next = paginationStrategy.buildNextRequest(currentEndpoint, currentOptions, cursor);
        currentEndpoint = next.endpoint;
        currentOptions = next.options;
      }

      if (pageCount >= maxPages) {
        throw new Error(
          `Pagination limit reached: ${maxPages} pages. This may indicate an infinite pagination loop. Consider using a more specific query.`,
        );
      }
    };

    const stream = async function* <T>(
      endpoint: string,
      options: RequestOptions = {},
    ): AsyncGenerator<StreamChunk<T>> {
      meridian.ensureStarted();

      const currentAdapter = meridian.adapters.get(providerName);
      if (!currentAdapter) {
        throw new Error(`Adapter not found for provider: ${providerName}`);
      }

      const providerConfig = meridian.config.providers?.[providerName];
      const authConfig = providerConfig?.auth ?? {};

      // Mirror pipeline auth resolution: resolve a token from the adapter's
      // auth strategy. refreshAuth is intentionally not wired for v1.
      const authToken = await currentAdapter.authStrategy(authConfig);

      const streamOptions: RequestOptions = {
        ...options,
        method: options.method ?? "POST",
      };

      const adapterInput: AdapterInput = {
        endpoint,
        options: streamOptions,
        authToken,
      };
      if (providerConfig?.baseUrl !== undefined) {
        adapterInput.baseUrl = providerConfig.baseUrl;
      }
      const built = currentAdapter.buildRequest(adapterInput);

      const fetchInit: RequestInit = {
        method: built.method,
        headers: built.headers,
      };
      if (built.body !== undefined) {
        fetchInit.body = built.body;
      }

      const response = await fetch(built.url, fetchInit);

      if (!response.ok) {
        // Normalize streaming errors to MeridianError like the rest of the SDK.
        let body: unknown;
        try {
          const contentType = response.headers.get("content-type");
          if (contentType?.includes("application/json")) {
            body = await response.json();
          } else {
            body = await response.text();
          }
        } catch {
          body = {};
        }
        throw currentAdapter.parseError({
          status: response.status,
          headers: response.headers,
          body,
        });
      }

      if (!response.body) {
        throw currentAdapter.parseError({
          status: response.status,
          headers: response.headers,
          body: { message: "Streaming response has no readable body." },
        });
      }

      const parseStreamChunk = currentAdapter.parseStreamChunk?.bind(currentAdapter);

      for await (const chunk of parseSSEStream(response.body)) {
        if (parseStreamChunk) {
          const data = parseStreamChunk(chunk.raw) as T;
          const mapped: StreamChunk<T> = { data, raw: chunk.raw };
          if (chunk.event !== undefined) {
            mapped.event = chunk.event;
          }
          yield mapped;
        } else {
          yield chunk as StreamChunk<T>;
        }
      }
    };

    const runWithConcurrency = async <T>(
      tasks: Array<() => Promise<T>>,
      concurrencyLimit: number,
    ): Promise<Array<T>> => {
      const results: T[] = new Array(tasks.length);
      let currentIndex = 0;

      const worker = async () => {
        while (currentIndex < tasks.length) {
          const index = currentIndex++;
          const task = tasks[index];
          if (task) {
            results[index] = await task();
          }
        }
      };

      const workers = Array.from({ length: Math.min(concurrencyLimit, tasks.length) }, () =>
        worker(),
      );
      await Promise.all(workers);
      return results;
    };

    return {
      get: <T = unknown>(endpoint: string, options?: RequestOptions) =>
        makeRequest<T>("GET", endpoint, options),
      post: <T = unknown>(endpoint: string, options?: RequestOptions) =>
        makeRequest<T>("POST", endpoint, options),
      put: <T = unknown>(endpoint: string, options?: RequestOptions) =>
        makeRequest<T>("PUT", endpoint, options),
      patch: <T = unknown>(endpoint: string, options?: RequestOptions) =>
        makeRequest<T>("PATCH", endpoint, options),
      delete: <T = unknown>(endpoint: string, options?: RequestOptions) =>
        makeRequest<T>("DELETE", endpoint, options),
      paginate: <T = unknown>(endpoint: string, options?: RequestOptions) =>
        paginate<T>(endpoint, options),
      stream: <T = unknown>(endpoint: string, options?: RequestOptions) =>
        stream<T>(endpoint, options),
      batch: async <T = unknown>(
        requests: Array<BatchRequest>,
        concurrencyLimit = 10,
      ): Promise<Array<NormalizedResponse<T> | MeridianError>> => {
        meridian.ensureStarted();
        const currentAdapter = meridian.adapters.get(providerName);
        if (!currentAdapter) {
          throw new Error(`Adapter not found for provider: ${providerName}`);
        }

        const tasks = requests.map((req) => async () => {
          try {
            return await makeRequest<T>(req.method, req.endpoint, req.options);
          } catch (err) {
            if (err instanceof MeridianError) {
              return err;
            }
            return currentAdapter.parseError(err);
          }
        });

        return runWithConcurrency(tasks, concurrencyLimit);
      },
    };
  }

  getCircuitStatus(provider: string): CircuitBreakerStatus | null {
    this.ensureStarted();
    const circuitBreaker = this.circuitBreakers.get(provider);
    return circuitBreaker?.getStatus() ?? null;
  }

  provider(name: "anthropic"): ProviderClient | undefined;
  provider(name: "openai"): ProviderClient | undefined;
  provider(name: "stripe"): ProviderClient | undefined;
  provider(name: "github"): ProviderClient | undefined;
  provider(name: "billdesk"): ProviderClient | undefined;
  provider(name: "ccavenue"): ProviderClient | undefined;
  provider(name: "datadog"): ProviderClient | undefined;
  provider(name: "razorpay"): ProviderClient | undefined;
  provider(name: "cashfree"): ProviderClient | undefined;
  provider(name: "payu"): ProviderClient | undefined;
  provider(name: "juspay"): ProviderClient | undefined;
  provider(name: "msg91"): ProviderClient | undefined;
  provider(name: "exotel"): ProviderClient | undefined;
  provider(name: "gupshup"): ProviderClient | undefined;
  provider(name: "setu"): ProviderClient | undefined;
  provider(name: "decentro"): ProviderClient | undefined;
  provider(name: "shiprocket"): ProviderClient | undefined;
  provider(name: "delhivery"): ProviderClient | undefined;
  provider(name: "hyperverge"): ProviderClient | undefined;
  provider(name: "digio"): ProviderClient | undefined;
  provider(name: "karza"): ProviderClient | undefined;
  provider(name: "idfy"): ProviderClient | undefined;
  provider(name: "cleartax"): ProviderClient | undefined;
  provider(name: "mapmyindia"): ProviderClient | undefined;
  provider(name: "perfios"): ProviderClient | undefined;
  provider(name: "twilio"): ProviderClient | undefined;
  provider(name: "sendgrid"): ProviderClient | undefined;
  provider(name: "sentry"): ProviderClient | undefined;
  provider(name: "mailgun"): ProviderClient | undefined;
  provider(name: "vonage"): ProviderClient | undefined;
  provider(name: "adyen"): ProviderClient | undefined;
  provider(name: "braintree"): ProviderClient | undefined;
  provider(name: "phonepe"): ProviderClient | undefined;
  provider(name: "gemini"): ProviderClient | undefined;
  provider(name: "auth0"): ProviderClient | undefined;
  provider(name: "hubspot"): ProviderClient | undefined;
  provider(name: "supabase"): ProviderClient | undefined;
  provider(name: "checkout"): ProviderClient | undefined;
  provider(name: "cohere"): ProviderClient | undefined;
  provider(name: "klarna"): ProviderClient | undefined;
  provider(name: "mistral"): ProviderClient | undefined;
  provider(name: "mollie"): ProviderClient | undefined;
  provider(name: "apollo"): ProviderClient | undefined;
  provider(name: "s3"): ProviderClient | undefined;
  provider(name: string): ProviderClient | undefined;

  provider(name: string): ProviderClient | undefined {
    this.ensureStarted();

    return (this as any)[name] as ProviderClient | undefined;
  }

  service(name: string): ServiceClient | undefined {
    this.ensureStarted();
    return this.serviceClients.get(name);
  }

  analytics(): Record<string, import("./analytics/collector.js").ProviderStats> {
    this.ensureStarted();
    return this.analyticsCollector.get();
  }

  health(): Record<
    string,
    {
      status: "healthy" | "degraded" | "down";
      successRate: string;
      avgLatency: number;
      circuitBreaker: CircuitState;
    }
  > {
    this.ensureStarted();
    const ah = this.analyticsCollector.getHealth();
    const result: Record<
      string,
      {
        status: "healthy" | "degraded" | "down";
        successRate: string;
        avgLatency: number;
        circuitBreaker: CircuitState;
      }
    > = {};

    for (const [name, cb] of this.circuitBreakers) {
      const cbStatus = cb.getStatus();
      const h = ah[name] ?? { status: "healthy" as const, successRate: "100.0%", avgLatency: 0 };
      let status = h.status;
      if (cbStatus.state === CircuitState.OPEN) status = "down";
      else if (cbStatus.state === CircuitState.HALF_OPEN && status === "healthy")
        status = "degraded";
      result[name] = { ...h, status, circuitBreaker: cbStatus.state };
    }

    return result;
  }

  cost(currency = "USD"): CostReport {
    this.ensureStarted();
    const costs = (this.config.providerCosts as Record<string, number> | undefined) ?? {};
    return this.analyticsCollector.getCost(costs, currency);
  }

  providers(): Array<{ name: string; capabilities: string[] }> {
    this.ensureStarted();
    return [...this.adapters.entries()].map(([name, adapter]) => {
      const registry = PROVIDER_CAPABILITIES[name] ?? [];
      const declared = adapter.capabilities?.() ?? [];
      return { name, capabilities: [...new Set([...registry, ...declared])] };
    });
  }

  findProviders(filter: { capability: string }): Array<{ name: string; capabilities: string[] }> {
    this.ensureStarted();
    return this.providers().filter((p) => p.capabilities.includes(filter.capability));
  }

  get debug(): DebugRecorder {
    return this.debugRecorder;
  }

  async replay(requestId: string): Promise<NormalizedResponse<unknown>> {
    this.ensureStarted();
    const rec = this.debugRecorder.recordings().find((r) => r.requestId === requestId);
    if (!rec) throw new Error(`No recording found for requestId: ${requestId}`);
    if (!rec.options) {
      throw new Error(
        `Recording "${requestId}" has no captured options. Call meridian.debug.enable() before the request to capture full replay data.`,
      );
    }
    const client = this.provider(rec.provider);
    if (!client) throw new Error(`Provider "${rec.provider}" is not configured`);
    const method = rec.method.toLowerCase() as "get" | "post" | "put" | "patch" | "delete";
    return client[method](rec.endpoint, rec.options);
  }

  get schema(): SchemaMonitor {
    if (!this._schemaMonitor) {
      const storage = this.config.schemaValidation?.storage ?? new FileSystemSchemaStorage();
      this._schemaMonitor = new SchemaMonitor(storage);
    }
    return this._schemaMonitor;
  }

  async transaction(steps: TransactionStep[]): Promise<TransactionResult> {
    this.ensureStarted();
    return runTransaction(steps);
  }

  async registerProvider(
    name: string,
    adapter: ProviderAdapter,
    config: ProviderConfig,
  ): Promise<void> {
    this.ensureStarted();

    this.adapters.set(name, adapter);

    if (!this.config.providers) {
      this.config.providers = {};
    }

    this.config.providers[name] = {
      ...config,
      adapter,
    };

    if (this.started) {
      await this.initializeProvider(name, this.config.providers[name]!);
    }
  }

  async start(): Promise<void> {
    if (this.config.mode === "distributed" && !this.config.stateStorage) {
      throw new Error(
        "Meridian requires a configured stateStorage in 'distributed' mode. " +
          "Provide a StateStorage implementation (e.g., Redis) for distributed deployments. " +
          "If you intend to use local in-memory state, set mode to 'local' or omit the mode field.",
      );
    }

    if (!this.config.stateStorage && !this.config.localUnsafe && this.config.mode !== "local") {
      throw new Error(
        "Meridian requires a configured stateStorage unless 'localUnsafe' is set to true. " +
          "For production deployments, provide a StateStorage implementation. " +
          "For local development, explicitly set 'localUnsafe: true' to acknowledge the limitation.",
      );
    }

    if (this.config.providers) {
      for (const [providerName, providerConfig] of Object.entries(this.config.providers)) {
        await this.initializeProvider(providerName, providerConfig as ProviderConfig);
      }
    }

    if (this.config.services) {
      for (const [serviceName, rawConfig] of Object.entries(this.config.services)) {
        const cfg = Array.isArray(rawConfig) ? { providers: rawConfig } : rawConfig;

        for (const name of cfg.providers) {
          if (!this.pipelines.has(name)) {
            throw new Error(
              `Service "${serviceName}" references provider "${name}" which is not configured. Add it to the providers section of the Meridian config.`,
            );
          }
        }

        const clients = cfg.providers.map((name) => this.createProviderClient(name));
        this.serviceClients.set(
          serviceName,
          new ServiceClient(cfg.providers, clients, cfg, () => this.analyticsCollector.get()),
        );
      }
    }

    if (this.config.mode !== "distributed" && this.config.localUnsafe) {
      this.emitLocalStateWarning();
    }

    this.started = true;
  }

  private ensureStarted(): void {
    if (!this.started) {
      throw new Error(
        "Meridian SDK must be initialized before use. " +
          "Call 'await Meridian.create(config)' and await the result before using any methods.",
      );
    }
  }
}

export * from "./core/types.js";
export * from "./observability/index.js";
export * from "./strategies/index.js";
export * from "./validation/index.js";
