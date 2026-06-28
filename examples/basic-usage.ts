import { Meridian } from "../src/index.js";
import { ConsoleObservability } from "../src/infrastructure/observability/console.js";
import { GitHubAdapter } from "../src/providers/crm/github/index.js";
import { FileSystemSchemaStorage } from "../src/infrastructure/validation/schema-storage.js";

async function main() {
  const meridian = await Meridian.create({
    providers: {
      github: {
        auth: {
          token: process.env.GITHUB_TOKEN || "",
        },
        circuitBreaker: {
          failureThreshold: 5,
          timeout: 30000,
          errorThresholdPercentage: 50,
        },
        rateLimit: {
          tokensPerSecond: 10,
          maxTokens: 100,
          adaptiveBackoff: true,
        },
        retry: {
          maxRetries: 3,
          baseDelay: 1000,
          maxDelay: 30000,
          jitter: true,
        },
      },
    },
    defaults: {
      timeout: 30000,
    },
    observability: new ConsoleObservability({ pretty: true }),
    schemaValidation: {
      enabled: true,
      storage: new FileSystemSchemaStorage("./.meridian/schemas"),
      onDrift: (drifts) => {
        console.warn("Schema drift detected:", drifts);
      },
      strictMode: false,
    },
    idempotency: {
      defaultLevel: "SAFE" as const,
      autoGenerateKeys: true,
    },
    localUnsafe: true,
  });

  try {
    console.log("Fetching user...");
    const { data, meta } = await meridian.github.get("/users/octocat");
    console.log("User data:", data);
    console.log("Rate limit remaining:", meta.rateLimit.remaining);

    const status = meridian.getCircuitStatus("github");
    console.log("Circuit breaker status:", status);

    console.log("\nFetching repositories with pagination...");
    let count = 0;
    for await (const response of meridian.github.paginate("/users/octocat/repos")) {
      const repos = response.data as Array<{ name: string }>;
      console.log(`Page ${++count}: ${repos.length} repos`);
      if (count >= 3) break;
    }
  } catch (error) {
    console.error("Error:", error);
    if ("type" in error && error.type === "CIRCUIT_OPEN") {
      console.log("Circuit is open, retry after:", (error as any).retryAfter);
    }
  }
}

main().catch(console.error);
