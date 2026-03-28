

import type {
  MeridianConfig,
  ProviderConfig,
  NormalizedResponse,
  CircuitBreakerStatus,
  ObservabilityAdapter,
  RequestOptions,
} from "./core/types.js";
import { RequestPipeline, type PipelineConfig } from "./core/pipeline.js";
import { ProviderCircuitBreaker } from "./strategies/circuit-breaker.js";
import { RateLimiter } from "./strategies/rate-limit.js";
import { RetryStrategy } from "./strategies/retry.js";
import { IdempotencyResolver } from "./strategies/idempotency.js";
import { IdempotencyLevel } from "./core/types.js";
import { ConsoleObservability } from "./observability/console.js";
import type { ProviderAdapter } from "./core/types.js";
import { assertValidAdapter } from "./core/adapter-validator.js";
import { GitHubAdapter } from "./providers/github/adapter.js";
import { AnthropicAdapter } from "./providers/anthropic/adapter.js";
import { OpenAIAdapter } from "./providers/openai/adapter.js";
import { StripeAdapter } from "./providers/stripe/adapter.js";
import { sanitizeObject } from "./core/observability-sanitizer.js";


const BUILTIN_ADAPTER_CLASSES: Record<string, new () => ProviderAdapter> = {
  github: GitHubAdapter,
  anthropic: AnthropicAdapter,
  openai: OpenAIAdapter,
  stripe: StripeAdapter,
};


function getBuiltinAdapter(
  name: string,
  cache: Map<string, ProviderAdapter>
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
  paginate<T = unknown>(endpoint: string, options?: RequestOptions): AsyncGenerator<NormalizedResponse<T>>;
}


export class Meridian {
  private config: MeridianConfig;
  private pipelines: Map<string, RequestPipeline> = new Map();
  private circuitBreakers: Map<string, ProviderCircuitBreaker> = new Map();
  private observability: ObservabilityAdapter[];
  private adapters: Map<string, ProviderAdapter> = new Map();
  private started = false;
  private adapterCache: Map<string, ProviderAdapter> = new Map();

  private constructor(config: MeridianConfig, adapters?: Map<string, ProviderAdapter>) {
    
    this.validateConfig(config);

    
    const providers = "providers" in config && config.providers
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
      this.config.observabilitySanitizer
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
                `  - ${adapter}: ${error instanceof Error ? error.message : String(error)}`
            )
            .join("\n")}`
        );
      } else if (errors.length > 0) {
        
        console.error(
          `[Meridian] Some observability adapters failed for logWarning (${errors.length}/${this.observability.length}):\n${errors
            .map(
              ({ adapter, error }) =>
                `  - ${adapter}: ${error instanceof Error ? error.message : String(error)}`
            )
            .join("\n")}`
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
    providerConfig: ProviderConfig
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
        `No adapter found for provider: ${providerName}. Provide adapter in config or use registerProvider().`
      );
    }

    
    await assertValidAdapter(adapter, providerName);

    
    this.adapters.set(providerName, adapter);

    
    const circuitBreakerConfig = {
      ...this.config.defaults?.circuitBreaker,
      ...providerConfig.circuitBreaker,
    };
    const circuitBreaker = new ProviderCircuitBreaker(
      providerName,
      circuitBreakerConfig
    );
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
      this.config.idempotency?.defaultLevel ?? IdempotencyLevel.SAFE
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
      autoGenerateIdempotencyKeys:
        this.config.idempotency?.autoGenerateKeys ?? false,
      sanitizerOptions: {
        ...(this.config.observabilitySanitizer ?? {}),
        piiRedaction: this.config.compliance?.piiRedaction,
      },
      compliance: this.config.compliance,
    };
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
      options: RequestOptions = {}
    ): Promise<NormalizedResponse<T>> => {
      meridian.ensureStarted();
      return pipeline.execute<T>(endpoint, {
        ...options,
        method: method as any,
      });
    };

    const paginate = async function* <T>(
      endpoint: string,
      options: RequestOptions = {}
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
            `This indicates a malformed pagination implementation. Stopping at page ${pageCount}.`
          );
        }
        seenCursors.add(cursor);

        const next = paginationStrategy.buildNextRequest(
          currentEndpoint,
          currentOptions,
          cursor
        );
        currentEndpoint = next.endpoint;
        currentOptions = next.options;
      }

      
      
      if (pageCount >= maxPages) {
        
        
        throw new Error(
          `Pagination limit reached: ${maxPages} pages. ` +
          `This may indicate an infinite pagination loop. Consider using a more specific query.`
        );
      }
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
  provider(name: string): ProviderClient | undefined;
  provider(name: string): ProviderClient | undefined {
    this.ensureStarted();
    
    
    
    return (this as any)[name] as ProviderClient | undefined;
  }

  async registerProvider(
    name: string,
    adapter: ProviderAdapter,
    config: ProviderConfig
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
        "If you intend to use local in-memory state, set mode to 'local' or omit the mode field."
      );
    }

    
    
    if (!this.config.stateStorage && !this.config.localUnsafe && this.config.mode !== "local") {
      throw new Error(
        "Meridian requires a configured stateStorage unless 'localUnsafe' is set to true. " +
        "For production deployments, provide a StateStorage implementation. " +
        "For local development, explicitly set 'localUnsafe: true' to acknowledge the limitation."
      );
    }

    
    if (this.config.providers) {
      for (const [providerName, providerConfig] of Object.entries(this.config.providers)) {
        await this.initializeProvider(providerName, providerConfig as ProviderConfig);
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
        "Call 'await Meridian.create(config)' and await the result before using any methods."
      );
    }
  }
}


export * from "./core/types.js";
export * from "./observability/index.js";
export * from "./strategies/index.js";
export * from "./validation/index.js";


