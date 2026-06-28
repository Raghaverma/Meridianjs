import { PROVIDER_CAPABILITIES } from "./capabilities/registry.js";
import { assertValidAdapter } from "./core/adapter-validator.js";
import { assertSafeEndpoint } from "./core/endpoint-validator.js";
import { sanitizeObject } from "./core/observability-sanitizer.js";
import { type PipelineConfig, RequestPipeline } from "./core/pipeline.js";
import { parseSSEStream, type StreamChunk } from "./core/streaming.js";
import type {
  AdapterInput,
  BatchRequest,
  CircuitBreakerStatus,
  MeridianConfig,
  NormalizedResponse,
  ObservabilityAdapter,
  ProviderAdapter,
  ProviderConfig,
  RequestOptions,
} from "./core/types.js";
import { CircuitState, IdempotencyLevel, MeridianError } from "./core/types.js";
import type { CostReport } from "./infrastructure/analytics/collector.js";
import { AnalyticsCollector } from "./infrastructure/analytics/collector.js";
import { DebugRecorder } from "./infrastructure/debug/recorder.js";
import {
  createOpenTelemetryObservability,
  type OpenTelemetryAutoOptions,
  type OTelApiLike,
} from "./infrastructure/observability/auto.js";
import { ConsoleObservability } from "./infrastructure/observability/console.js";
import type { OpenTelemetryObservability } from "./infrastructure/observability/otel.js";
import { ContractRegistry } from "./infrastructure/registry/contract-registry.js";
import type { ReliabilitySession } from "./infrastructure/replay/recorder.js";
import { ReliabilityRecorder } from "./infrastructure/replay/recorder.js";
import type { ReplayOptions, ReplaySummary } from "./infrastructure/replay/replayer.js";
import { replaySession as runReplaySession } from "./infrastructure/replay/replayer.js";
import { ReliabilityStore } from "./infrastructure/replay/store.js";
import { SchemaMonitor } from "./infrastructure/schema/monitor.js";
import { FileSystemSchemaStorage } from "./infrastructure/validation/schema-storage.js";
import { ServiceClient } from "./networking/services/service-client.js";
import type { TransactionResult, TransactionStep } from "./orchestration/transactions/saga.js";
import { runTransaction } from "./orchestration/transactions/saga.js";
import { AnthropicAdapter } from "./providers/ai/anthropic/adapter.js";
import { CohereAdapter } from "./providers/ai/cohere/adapter.js";
import { GeminiAdapter } from "./providers/ai/gemini/adapter.js";
import { MistralAdapter } from "./providers/ai/mistral/adapter.js";
import { OpenAIAdapter } from "./providers/ai/openai/adapter.js";
import { GitHubAdapter } from "./providers/crm/github/adapter.js";
import { HubSpotAdapter } from "./providers/crm/hubspot/adapter.js";
import { HunterAdapter } from "./providers/crm/hunter/adapter.js";
import { ApolloAdapter } from "./providers/healthcare/apollo/adapter.js";
import { Auth0Adapter } from "./providers/identity/auth0/adapter.js";
import { DecentroAdapter } from "./providers/identity/decentro/adapter.js";
import { DigioAdapter } from "./providers/identity/digio/adapter.js";
import { HyperVergeAdapter } from "./providers/identity/hyperverge/adapter.js";
import { IdfyAdapter } from "./providers/identity/idfy/adapter.js";
import { KarzaAdapter } from "./providers/identity/karza/adapter.js";
import { PerfiosAdapter } from "./providers/identity/perfios/adapter.js";
import { SetuAdapter } from "./providers/identity/setu/adapter.js";
import { DelhiveryAdapter } from "./providers/logistics/delhivery/adapter.js";
import { ShiprocketAdapter } from "./providers/logistics/shiprocket/adapter.js";
import { GoogleMapsAdapter } from "./providers/maps/googlemaps/adapter.js";
import { MapmyindiaAdapter } from "./providers/maps/mapmyindia/adapter.js";
import { ExotelAdapter } from "./providers/messaging/exotel/adapter.js";
import { GupshupAdapter } from "./providers/messaging/gupshup/adapter.js";
import { MailgunAdapter } from "./providers/messaging/mailgun/adapter.js";
import { Msg91Adapter } from "./providers/messaging/msg91/adapter.js";
import { SendgridAdapter } from "./providers/messaging/sendgrid/adapter.js";
import { TwilioAdapter } from "./providers/messaging/twilio/adapter.js";
import { VonageAdapter } from "./providers/messaging/vonage/adapter.js";
import { DatadogAdapter } from "./providers/monitoring/datadog/adapter.js";
import { SentryAdapter } from "./providers/monitoring/sentry/adapter.js";
import { AdyenAdapter } from "./providers/payments/adyen/adapter.js";
import { BilldeskAdapter } from "./providers/payments/billdesk/adapter.js";
import { BraintreeAdapter } from "./providers/payments/braintree/adapter.js";
import { CashfreeAdapter } from "./providers/payments/cashfree/adapter.js";
import { CcavenueAdapter } from "./providers/payments/ccavenue/adapter.js";
import { CheckoutAdapter } from "./providers/payments/checkout/adapter.js";
import { JuspayAdapter } from "./providers/payments/juspay/adapter.js";
import { KlarnaAdapter } from "./providers/payments/klarna/adapter.js";
import { MollieAdapter } from "./providers/payments/mollie/adapter.js";
import { PayuAdapter } from "./providers/payments/payu/adapter.js";
import { PhonePeAdapter } from "./providers/payments/phonepe/adapter.js";
import { RazorpayAdapter } from "./providers/payments/razorpay/adapter.js";
import { StripeAdapter } from "./providers/payments/stripe/adapter.js";
import { S3Adapter } from "./providers/storage/s3/adapter.js";
import { SupabaseAdapter } from "./providers/storage/supabase/adapter.js";
import { CleartaxAdapter } from "./providers/tax/cleartax/adapter.js";
import { ProviderCircuitBreaker } from "./resilience/circuit-breaker.js";
import { IdempotencyResolver } from "./resilience/idempotency.js";
import { RateLimiter } from "./resilience/rate-limit.js";
import { RetryStrategy } from "./resilience/retry.js";
import { SharedCooldownManager } from "./resilience/shared-cooldown.js";
import {
  createStudioServer,
  type StudioServerHandle,
  type StudioServerOptions,
} from "./studio/server.js";

export const BUILTIN_ADAPTER_CLASSES: Record<string, new () => ProviderAdapter> = {
  github: GitHubAdapter,
  googlemaps: GoogleMapsAdapter,
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
  hunter: HunterAdapter,
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
  private _registry: ContractRegistry | null = null;
  private otelObservability: OpenTelemetryObservability | null = null;
  private reliabilityRecorder = new ReliabilityRecorder(
    (provider) => this.circuitBreakers.get(provider)?.getStatus().state,
  );

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
              "telemetry",
              "services",
              "policies",
              "providerCosts",
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

    this.observability = [
      ...this.observability,
      this.analyticsCollector,
      this.debugRecorder,
      this.reliabilityRecorder,
    ];
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
    if (this.config.stateStorage && this.config.sharedCooldown !== false) {
      pipelineConfig.sharedCooldown = new SharedCooldownManager(this.config.stateStorage);
    }
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
          // Natural end of results — finish the generator. Using `return` (not
          // `break`) is important: a clean completion on exactly the maxPages-th
          // page must not fall through to the limit check below and raise a
          // spurious "infinite pagination loop" error after every page has
          // already been yielded.
          return;
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

      // The streaming path builds the request directly (bypassing the pipeline),
      // so apply the same endpoint guard here to prevent host-override.
      assertSafeEndpoint(endpoint, providerName);

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
  provider(name: "hunter"): ProviderClient | undefined;
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

  analytics(): Record<string, import("./infrastructure/analytics/collector.js").ProviderStats> {
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

  /**
   * Local contract registry: versioned response-schema snapshots with drift
   * history under `.meridian/registry/`, designed to be committed to git and
   * enforced in CI (`meridian registry check` exits non-zero on breaking
   * drift).
   */
  get registry(): ContractRegistry {
    if (!this._registry) {
      this._registry = new ContractRegistry();
    }
    return this._registry;
  }

  /**
   * Starts a named reliability recording session. Every request through the
   * pipeline is captured as a timeline event (outcome, retries, breaker state,
   * latency — never bodies) until stopRecording(). Returns the session name.
   */
  startRecording(name?: string): string {
    this.ensureStarted();
    const sessionName =
      name ?? `session-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-")}`;
    this.reliabilityRecorder.start(sessionName);
    return sessionName;
  }

  /** Whether a reliability recording is currently active, and under what name. */
  recordingStatus(): { active: boolean; sessionName: string | null } {
    return {
      active: this.reliabilityRecorder.recording,
      sessionName: this.reliabilityRecorder.sessionName,
    };
  }

  /**
   * Starts the Meridian Studio HTTP API in-process, attached to this instance —
   * health, cost, circuit-breaker, and recording-control endpoints serve live
   * data. Pair it with the Meridian Studio dashboard (a separate app — see
   * docs/studio.md) for a UI, or query the JSON endpoints directly.
   */
  async studio(opts: Omit<StudioServerOptions, "meridian"> = {}): Promise<StudioServerHandle> {
    this.ensureStarted();
    return createStudioServer({ ...opts, meridian: this });
  }

  /**
   * Stops the active recording session. Persists it to
   * `.meridian/recordings/<name>.json` (override with `dir`, or skip with
   * `save: false`) so it can be replayed later — `meridian replay <name>`
   * from the CLI, or replaySession() programmatically.
   */
  async stopRecording(options: { dir?: string; save?: boolean } = {}): Promise<ReliabilitySession> {
    const session = this.reliabilityRecorder.stop();
    if (options.save !== false) {
      await new ReliabilityStore(options.dir).save(session);
    }
    return session;
  }

  /**
   * Replays a recorded session locally — retries, failovers, and breaker
   * transitions re-fire in order into `onEvent` / `emitTo` adapters, without
   * touching real providers — and returns the derived outage summary.
   */
  async replaySession(
    nameOrSession: string | ReliabilitySession,
    options: ReplayOptions & { dir?: string } = {},
  ): Promise<ReplaySummary> {
    const { dir, ...replayOptions } = options;
    const session =
      typeof nameOrSession === "string"
        ? await new ReliabilityStore(dir).load(nameOrSession)
        : nameOrSession;
    return runReplaySession(session, replayOptions);
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

  /**
   * Adds OpenTelemetry instrumentation to a running client. Equivalent to the
   * `telemetry: { provider: "opentelemetry" }` config shorthand; useful when
   * the OTel SDK is registered after Meridian is created. Idempotent.
   */
  async instrumentOpenTelemetry(
    options: OpenTelemetryAutoOptions = {},
    api?: OTelApiLike,
  ): Promise<void> {
    if (this.otelObservability) return;
    this.otelObservability = await createOpenTelemetryObservability(options, api);
    // Pipelines hold a reference to this array, so they pick the adapter up
    // immediately — including pipelines created before this call.
    this.observability.push(this.otelObservability);
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

    if (this.config.telemetry?.provider === "opentelemetry") {
      const { name, metricPrefix, api } = this.config.telemetry;
      const options: OpenTelemetryAutoOptions = {};
      if (name !== undefined) options.name = name;
      if (metricPrefix !== undefined) options.metricPrefix = metricPrefix;
      await this.instrumentOpenTelemetry(options, api as OTelApiLike | undefined);
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
          new ServiceClient(
            cfg.providers,
            clients,
            cfg,
            () => this.analyticsCollector.get(),
            () => {
              const states: Record<string, string> = {};
              for (const [name, cb] of this.circuitBreakers) {
                states[name] = cb.getStatus().state;
              }
              return states;
            },
          ),
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
export * from "./infrastructure/observability/index.js";
export * from "./infrastructure/validation/index.js";
export * from "./resilience/index.js";
