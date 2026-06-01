import { Meridian } from "../../src/index.js";
import { MockAdapter } from "../../src/testing/mock-adapter.js";

// ANSI colors for beautiful terminal output
const bold = (txt: string) => `\x1b[1m${txt}\x1b[22m`;
const green = (txt: string) => `\x1b[32m${txt}\x1b[39m`;
const blue = (txt: string) => `\x1b[34m${txt}\x1b[39m`;
const yellow = (txt: string) => `\x1b[33m${txt}\x1b[39m`;
const magenta = (txt: string) => `\x1b[35m${txt}\x1b[39m`;
const cyan = (txt: string) => `\x1b[36m${txt}\x1b[39m`;
const red = (txt: string) => `\x1b[31m${txt}\x1b[39m`;

// 1. Configure Mock Adapters to simulate Stripe & Razorpay without real network calls
const stripeMock = new MockAdapter("stripe");
stripeMock.baseUrl = "https://stripe.mock.meridian.local";

stripeMock.paginationStrategy = () => {
  return {
    extractCursor(response) {
      if (typeof response.body === "object" && response.body !== null) {
        const b = response.body as any;
        if (b.has_more) return "ch_2";
      }
      return null;
    },
    extractTotal() {
      return 2;
    },
    hasNext(response) {
      return this.extractCursor(response) !== null;
    },
    buildNextRequest(endpoint, options, cursor) {
      return {
        endpoint,
        options: { ...options, query: { ...options.query, starting_after: cursor } },
      };
    },
  };
};

stripeMock
  .onRequest({ method: "POST", endpoint: "/v1/customers" }, () => ({
    status: 201,
    body: {
      id: "cus_stripe_abc123",
      object: "customer",
      email: "swap@example.com",
      name: "Swap User",
    },
  }))
  .onRequest({ method: "GET", endpoint: "/v1/charges" }, (method, endpoint, options) => {
    const hasMore = !options.query?.starting_after;
    return {
      status: 200,
      headers: {
        "Stripe-Ratelimit-Limit": "100",
        "Stripe-Ratelimit-Remaining": "98",
      },
      body: {
        data: hasMore
          ? [{ id: "ch_1", amount: 2000, currency: "usd" }]
          : [{ id: "ch_2", amount: 3000, currency: "usd" }],
        has_more: hasMore,
      },
    };
  });

const razorpayMock = new MockAdapter("razorpay");
razorpayMock.baseUrl = "https://razorpay.mock.meridian.local";

razorpayMock.paginationStrategy = () => {
  return {
    extractCursor(response) {
      if (typeof response.body === "object" && response.body !== null) {
        const b = response.body as any;
        if (b.has_more) return "2";
      }
      return null;
    },
    extractTotal() {
      return 2;
    },
    hasNext(response) {
      return this.extractCursor(response) !== null;
    },
    buildNextRequest(endpoint, options, cursor) {
      return { endpoint, options: { ...options, query: { ...options.query, page: cursor } } };
    },
  };
};

razorpayMock
  .onRequest({ method: "POST", endpoint: "/v1/customers" }, () => ({
    status: 201,
    body: {
      id: "cust_razor_xyz789",
      entity: "customer",
      email: "swap@example.com",
      name: "Swap User",
    },
  }))
  .onRequest({ method: "GET", endpoint: "/v1/payments" }, (method, endpoint, options) => {
    const hasMore = !options.query?.page;
    return {
      status: 200,
      body: {
        entity: "collection",
        count: 2,
        items: hasMore
          ? [{ id: "pay_1", amount: 2000, currency: "INR" }]
          : [{ id: "pay_2", amount: 3000, currency: "INR" }],
        has_more: hasMore,
      },
    };
  });

// 2. Intercept global fetch so that requests to mock endpoints are routed to the mock adapters
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url: RequestInfo | URL, init?: RequestInit) => {
  const urlStr = url.toString();
  console.log(`[DEBUG FETCH INTERCEPTOR] Called with URL: "${urlStr}"`);
  const parsedUrl = new URL(urlStr);
  const method = init?.method ?? "GET";

  let body: any = undefined;
  if (init?.body) {
    try {
      body = JSON.parse(init.body as string);
    } catch {
      body = init.body;
    }
  }

  const query: Record<string, string> = {};
  parsedUrl.searchParams.forEach((val, key) => {
    query[key] = val;
  });

  const options: any = {
    method,
    headers: init?.headers,
    body,
    query,
  };

  if (urlStr.includes("stripe")) {
    console.log(`[DEBUG FETCH INTERCEPTOR] Routing to stripeMock: ${method} ${parsedUrl.pathname}`);
    const rawRes = await stripeMock.resolve(method, parsedUrl.pathname, options);
    const resHeaders = new Headers(rawRes.headers);
    if (!resHeaders.has("content-type")) {
      resHeaders.set("content-type", "application/json");
    }
    return new Response(JSON.stringify(rawRes.body), {
      status: rawRes.status,
      headers: resHeaders,
    });
  }

  if (urlStr.includes("razorpay")) {
    console.log(
      `[DEBUG FETCH INTERCEPTOR] Routing to razorpayMock: ${method} ${parsedUrl.pathname}`,
    );
    const rawRes = await razorpayMock.resolve(method, parsedUrl.pathname, options);
    const resHeaders = new Headers(rawRes.headers);
    if (!resHeaders.has("content-type")) {
      resHeaders.set("content-type", "application/json");
    }
    return new Response(JSON.stringify(rawRes.body), {
      status: rawRes.status,
      headers: resHeaders,
    });
  }

  console.log("[DEBUG FETCH INTERCEPTOR] Falling back to originalFetch");
  return originalFetch(url, init);
};

async function runBillingOperations(meridian: Meridian, providerName: string) {
  console.log(`\n${bold(magenta("=================================================="))}`);
  console.log(
    `  ${bold(cyan("RUNNING BILLING CYCLE ON PROVIDER:"))} ${bold(yellow(providerName.toUpperCase()))}`,
  );
  console.log(`${bold(magenta("=================================================="))}\n`);

  const client = meridian.provider(providerName);
  if (!client) {
    throw new Error(`Provider ${providerName} not found in Meridian configuration.`);
  }

  // Operation 1: Normalized Response Structure
  console.log(bold("1. Creating customer (Normalized response checking)..."));
  const createRes = await client.post("/v1/customers", {
    body: { name: "Swap User", email: "swap@example.com" },
  });

  console.log(`   - Raw Provider ID:   ${green((createRes.data as any).id)}`);
  console.log(`   - Normalized Meta:   ${blue(JSON.stringify(createRes.meta))}`);
  console.log(`   - Provider Identity: ${yellow(createRes.meta.provider)}`);
  console.log(`   - Request ID:        ${yellow(createRes.meta.requestId ?? "N/A")}\n`);

  // Operation 2: Pagination Normalization
  console.log(bold("2. Listing transactions (Unified pagination check)..."));
  const endpoint = providerName === "stripe" ? "/v1/charges" : "/v1/payments";

  let pageCount = 0;
  for await (const page of client.paginate(endpoint)) {
    pageCount++;
    console.log(`   - Page ${pageCount} metadata: ${blue(JSON.stringify(page.meta.pagination))}`);
    const items = (page.data as any).data || (page.data as any).items || [];
    console.log(`   - Fetched ${items.length} transaction(s). First ID: ${green(items[0]?.id)}`);
  }
}

async function runErrorHandlingDemo(meridian: Meridian) {
  console.log(`\n${bold(magenta("=================================================="))}`);
  console.log(`  ${bold(cyan("UNIFIED ERROR & RATE LIMIT HANDLING DEMO"))}`);
  console.log(`${bold(magenta("=================================================="))}\n`);

  // We will simulate a Rate Limit (429) error on Stripe and show how the catch block remains completely identical
  stripeMock.simulateError(
    { method: "POST", endpoint: "/v1/customers" },
    {
      message: "Stripe rate limit exceeded. Please slow down.",
      category: "rate_limit",
      status: 429,
      retryable: true,
    },
  );

  const providers = ["stripe", "razorpay"];

  for (const providerName of providers) {
    console.log(bold(`Attempting customer creation on ${yellow(providerName.toUpperCase())}...`));
    const client = meridian.provider(providerName);

    // Set a custom rate-limiting simulation on Razorpay to show error category mapping
    if (providerName === "razorpay") {
      razorpayMock.simulateError(
        { method: "POST", endpoint: "/v1/customers" },
        {
          message: "Razorpay too many requests.",
          category: "rate_limit",
          status: 429,
          retryable: true,
        },
      );
    }

    try {
      await client!.post("/v1/customers", {
        body: { name: "Swap User", email: "swap@example.com" },
      });
    } catch (error) {
      if (error instanceof Error && "category" in error) {
        const meridianErr = error as any;
        console.log(`   ${bold(yellow("→ Caught MeridianError!"))}`);
        console.log(`     - Provider:  ${magenta(meridianErr.provider)}`);
        console.log(`     - Category:  ${red(meridianErr.category)} (expected: rate_limit)`);
        console.log(`     - Retryable: ${green(String(meridianErr.retryable))}`);
        console.log(`     - Message:   "${meridianErr.message}"`);
      } else {
        console.error("   - Unexpected error:", error);
      }
    }
    console.log();
  }
}

async function main() {
  console.log(bold(green("Starting Meridian Provider Swapping Demonstration...")));

  // Registering both providers in Meridian, passing mock adapters to run offline
  const adapters = new Map();
  adapters.set("stripe", stripeMock);
  adapters.set("razorpay", razorpayMock);

  const meridian = await Meridian.create(
    {
      providers: {
        stripe: {
          baseUrl: "https://stripe.mock.meridian.local",
          auth: { apiKey: "sk_test_mock" },
        },
        razorpay: {
          baseUrl: "https://razorpay.mock.meridian.local",
          auth: { username: "rzp_id_mock", password: "rzp_secret_mock" },
        },
      },
      localUnsafe: true,
    },
    adapters,
  );

  // 1. Run operations on Stripe
  await runBillingOperations(meridian, "stripe");

  // 2. Run the exact same operations on Razorpay (zero downstream changes to runBillingOperations)
  await runBillingOperations(meridian, "razorpay");

  // 3. Demonstrate unified error handling
  await runErrorHandlingDemo(meridian);

  console.log(bold(green("\nProvider Swapping demonstration completed successfully!")));
}

main().catch(console.error);
