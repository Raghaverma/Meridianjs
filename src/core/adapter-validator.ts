import {
  type AdapterInput,
  type AuthConfig,
  MeridianError,
  type PaginationStrategy,
  type ProviderAdapter,
  type RawResponse,
} from "./types.js";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export async function validateAdapter(
  adapter: ProviderAdapter,
  providerName: string,
): Promise<ValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  const requiredMethods: Array<keyof ProviderAdapter> = [
    "buildRequest",
    "parseResponse",
    "parseError",
    "authStrategy",
    "rateLimitPolicy",
    "paginationStrategy",
    "getIdempotencyConfig",
  ];

  for (const method of requiredMethods) {
    if (typeof adapter[method] !== "function") {
      errors.push(`Adapter missing required method: ${String(method)}`);
    }
  }

  if (typeof adapter.buildRequest === "function") {
    try {
      const input: AdapterInput = {
        endpoint: "/test",
        options: { method: "GET" },
        authToken: { token: "test" },
      };
      const built = adapter.buildRequest(input);

      if (!built || typeof built !== "object") {
        errors.push("buildRequest must return BuiltRequest object");
      } else {
        if (typeof built.url !== "string") {
          errors.push("buildRequest must return url as string");
        }
        if (typeof built.method !== "string") {
          errors.push("buildRequest must return method as string");
        }
        if (!built.headers || typeof built.headers !== "object") {
          errors.push("buildRequest must return headers as object");
        }
      }
    } catch (error) {
      errors.push(
        `buildRequest threw error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (typeof adapter.parseResponse === "function") {
    try {
      const raw: RawResponse = {
        status: 200,
        headers: new Headers({
          "X-RateLimit-Limit": "5000",
          "X-RateLimit-Remaining": "4999",
          "X-RateLimit-Reset": String(Math.floor(Date.now() / 1000) + 3600),
        }),
        body: { test: "data" },
      };
      const normalized = adapter.parseResponse(raw);

      if (!normalized || typeof normalized !== "object") {
        errors.push("parseResponse must return NormalizedResponse object");
      } else {
        if (!("data" in normalized)) {
          errors.push("parseResponse must return object with 'data' property");
        }
        if (!("meta" in normalized)) {
          errors.push("parseResponse must return object with 'meta' property");
        } else {
          const meta = normalized.meta;
          if (meta.provider !== providerName) {
            errors.push(
              `parseResponse meta.provider must be '${providerName}', got '${meta.provider}'`,
            );
          }
          if (!meta.rateLimit) {
            errors.push("parseResponse meta must include rateLimit");
          } else {
            if (typeof meta.rateLimit.limit !== "number") {
              errors.push("rateLimit.limit must be number");
            }
            if (typeof meta.rateLimit.remaining !== "number") {
              errors.push("rateLimit.remaining must be number");
            }
            if (!(meta.rateLimit.reset instanceof Date)) {
              errors.push("rateLimit.reset must be Date");
            }
          }
        }
      }
    } catch (error) {
      errors.push(
        `parseResponse threw error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (typeof adapter.parseError === "function") {
    const testErrors = [
      { status: 401, headers: new Headers(), body: { message: "Unauthorized" } },
      { status: 404, headers: new Headers(), body: { message: "Not Found" } },
      { status: 429, headers: new Headers(), body: { message: "Rate Limited" } },
      { status: 500, headers: new Headers(), body: { message: "Server Error" } },
      new Error("Network error"),
    ];

    for (const testError of testErrors) {
      try {
        const error: unknown = adapter.parseError(testError);

        if (!(error instanceof MeridianError)) {
          if (error instanceof Error) {
            errors.push(
              "parseError must return MeridianError instance (extends Error), got Error-like object without proper inheritance",
            );
          } else {
            errors.push("parseError must return MeridianError instance");
          }
          continue;
        }

        const validCategories = ["auth", "rate_limit", "network", "provider", "validation"];
        if (!validCategories.includes(error.category)) {
          errors.push(
            `parseError returned invalid category: ${error.category}. Must be one of: ${validCategories.join()}`,
          );
        }

        if (typeof error.retryable !== "boolean") {
          errors.push("parseError returned MeridianError with non-boolean 'retryable' property");
        }

        if (error.provider !== providerName) {
          errors.push(
            `parseError returned provider '${error.provider}', expected '${providerName}'`,
          );
        }

        if (typeof error.requestId !== "string") {
          errors.push("parseError must return MeridianError with requestId as string");
        }

        const providerSpecificFields = ["documentation_url", "github_message", "stripe_error"];
        for (const field of providerSpecificFields) {
          if (field in error && !(field in Error.prototype)) {
            warnings.push(
              `parseError may be leaking provider-specific field: ${field}. Consider moving to metadata.`,
            );
          }
        }
      } catch (error) {
        errors.push(
          `parseError threw error for test case: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  if (typeof adapter.authStrategy === "function") {
    try {
      const config: AuthConfig = { token: "MERIDIAN_TEST_TOKEN_DO_NOT_VALIDATE" };
      const tokenPromise = adapter.authStrategy(config);

      if (!(tokenPromise instanceof Promise)) {
        errors.push("authStrategy must return Promise<AuthToken>");
      } else {
        try {
          const token = await tokenPromise;
          if (!token || typeof token !== "object") {
            errors.push("authStrategy must return AuthToken object");
          } else if (typeof token.token !== "string") {
            errors.push("authStrategy must return token as string");
          }
        } catch (error) {
          if (error instanceof Error && "category" in error) {
            const meridianError = error as MeridianError;
            if (meridianError.category !== "auth") {
              warnings.push(
                "authStrategy should throw MeridianError with category 'auth' on failure",
              );
            }
          } else {
            warnings.push("authStrategy should throw MeridianError, not raw Error");
          }
        }
      }
    } catch (error) {
      errors.push(
        `authStrategy threw synchronous error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (typeof adapter.rateLimitPolicy === "function") {
    try {
      const headers = new Headers({
        "X-RateLimit-Limit": "5000",
        "X-RateLimit-Remaining": "4999",
        "X-RateLimit-Reset": String(Math.floor(Date.now() / 1000) + 3600),
      });
      const rateLimit = adapter.rateLimitPolicy(headers);

      if (!rateLimit || typeof rateLimit !== "object") {
        errors.push("rateLimitPolicy must return RateLimitInfo object");
      } else {
        if (typeof rateLimit.limit !== "number") {
          errors.push("rateLimitPolicy must return limit as number");
        }
        if (typeof rateLimit.remaining !== "number") {
          errors.push("rateLimitPolicy must return remaining as number");
        }
        if (!(rateLimit.reset instanceof Date)) {
          errors.push("rateLimitPolicy must return reset as Date");
        }
      }
    } catch (error) {
      errors.push(
        `rateLimitPolicy threw error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (typeof adapter.paginationStrategy === "function") {
    try {
      const strategy = adapter.paginationStrategy();

      if (!strategy || typeof strategy !== "object") {
        errors.push("paginationStrategy must return PaginationStrategy object");
      } else {
        const requiredMethods = ["extractCursor", "extractTotal", "hasNext", "buildNextRequest"];
        for (const method of requiredMethods) {
          if (typeof strategy[method as keyof PaginationStrategy] !== "function") {
            errors.push(`paginationStrategy must implement ${method} method`);
          }
        }
      }
    } catch (error) {
      errors.push(
        `paginationStrategy threw error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (typeof adapter.getIdempotencyConfig === "function") {
    try {
      const config = adapter.getIdempotencyConfig();

      if (!config || typeof config !== "object") {
        errors.push("getIdempotencyConfig must return IdempotencyConfig object");
      } else {
        if (!(config.defaultSafeOperations instanceof Set)) {
          errors.push("getIdempotencyConfig must return defaultSafeOperations as Set");
        }
        if (!(config.operationOverrides instanceof Map)) {
          errors.push("getIdempotencyConfig must return operationOverrides as Map");
        }
      }
    } catch (error) {
      errors.push(
        `getIdempotencyConfig threw error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

export async function assertValidAdapter(
  adapter: ProviderAdapter,
  providerName: string,
): Promise<void> {
  const result = await validateAdapter(adapter, providerName);

  if (!result.valid || result.warnings.length > 0) {
    const errorMessage = [
      `Adapter validation failed for '${providerName}':`,
      ...result.errors.map((e) => `  - ERROR: ${e}`),
      ...result.warnings.map((w) => `  - WARNING (treated as error): ${w}`),
    ].join("\n");

    throw new Error(errorMessage);
  }
}

export function isProviderAdapter(obj: unknown): obj is ProviderAdapter {
  if (!obj || typeof obj !== "object") {
    return false;
  }

  const requiredMethods: Array<keyof ProviderAdapter> = [
    "buildRequest",
    "parseResponse",
    "parseError",
    "authStrategy",
    "rateLimitPolicy",
    "paginationStrategy",
    "getIdempotencyConfig",
  ];

  return requiredMethods.every((method) => typeof (obj as any)[method] === "function");
}
