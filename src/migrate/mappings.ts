/**
 * Per-provider migration knowledge: how to recognize direct SDK/HTTP usage in
 * a codebase, and what each call maps to in Meridian. Patterns are line-level
 * heuristics (no type information), so anything ambiguous is reported as
 * "needs manual attention" rather than guessed.
 */

export interface MethodMapping {
  /** Source pattern matched against a single line. */
  pattern: RegExp;
  /** Suggested Meridian replacement. */
  meridian: string;
  /** When set, the call needs a human (path params, streaming, options reshaping). */
  manual?: string;
}

export interface MigrationMapping {
  provider: string;
  displayName: string;
  /** npm package names whose import/require indicates direct SDK usage. */
  packages: string[];
  /** Constructor names typically used with `new`. */
  constructors: string[];
  /** API hostnames that indicate hand-rolled fetch/axios calls. */
  apiHosts: string[];
  methods: MethodMapping[];
  /** Suggested provider block for the Meridian config. */
  configSnippet: string;
}

export const MIGRATIONS: Record<string, MigrationMapping> = {
  openai: {
    provider: "openai",
    displayName: "OpenAI",
    packages: ["openai"],
    constructors: ["OpenAI"],
    apiHosts: ["api.openai.com"],
    methods: [
      {
        pattern: /\.chat\.completions\.create\s*\(/,
        meridian: 'meridian.openai.post("/v1/chat/completions", { body: { …same payload… } })',
      },
      {
        pattern: /\.embeddings\.create\s*\(/,
        meridian: 'meridian.openai.post("/v1/embeddings", { body: { …same payload… } })',
      },
      {
        pattern: /\.models\.list\s*\(/,
        meridian: 'meridian.openai.get("/v1/models")',
      },
      {
        pattern: /\.images\.generate\s*\(/,
        meridian: 'meridian.openai.post("/v1/images/generations", { body: { …same payload… } })',
      },
      {
        pattern: /stream\s*:\s*true/,
        meridian:
          'meridian.openai.stream("/v1/chat/completions", { body: { …payload, stream: true } })',
        manual:
          "Streaming responses use meridian.openai.stream() — the chunk shape differs from the SDK's.",
      },
    ],
    configSnippet: `openai: {
  auth: { apiKey: process.env.OPENAI_API_KEY ?? "" },
}`,
  },
  anthropic: {
    provider: "anthropic",
    displayName: "Anthropic",
    packages: ["@anthropic-ai/sdk"],
    constructors: ["Anthropic"],
    apiHosts: ["api.anthropic.com"],
    methods: [
      {
        pattern: /\.messages\.create\s*\(/,
        meridian: 'meridian.anthropic.post("/v1/messages", { body: { …same payload… } })',
      },
      {
        pattern: /\.messages\.stream\s*\(/,
        meridian: 'meridian.anthropic.stream("/v1/messages", { body: { …payload, stream: true } })',
        manual:
          "Streaming responses use meridian.anthropic.stream() — the chunk shape differs from the SDK's.",
      },
    ],
    configSnippet: `anthropic: {
  auth: { apiKey: process.env.ANTHROPIC_API_KEY ?? "" },
}`,
  },
  stripe: {
    provider: "stripe",
    displayName: "Stripe",
    packages: ["stripe"],
    constructors: ["Stripe"],
    apiHosts: ["api.stripe.com"],
    methods: [
      {
        pattern: /\.charges\.create\s*\(/,
        meridian: 'meridian.stripe.post("/v1/charges", { body: { …same payload… } })',
      },
      {
        pattern: /\.paymentIntents\.create\s*\(/,
        meridian: 'meridian.stripe.post("/v1/payment_intents", { body: { …same payload… } })',
      },
      {
        pattern: /\.customers\.create\s*\(/,
        meridian: 'meridian.stripe.post("/v1/customers", { body: { …same payload… } })',
      },
      {
        pattern: /\.customers\.retrieve\s*\(/,
        meridian: "meridian.stripe.get(`/v1/customers/${id}`)",
        manual: "The customer id moves from an argument into the endpoint path.",
      },
      {
        pattern: /\.refunds\.create\s*\(/,
        meridian: 'meridian.stripe.post("/v1/refunds", { body: { …same payload… } })',
      },
      {
        pattern: /\.subscriptions\.create\s*\(/,
        meridian: 'meridian.stripe.post("/v1/subscriptions", { body: { …same payload… } })',
      },
      {
        pattern: /\.webhooks\.constructEvent\s*\(/,
        meridian: "new StripeAdapter().verifyWebhook(payload, signature, secret)",
        manual:
          "Webhook verification returns a boolean in Meridian; parse the payload yourself after verifying.",
      },
    ],
    configSnippet: `stripe: {
  auth: { apiKey: process.env.STRIPE_SECRET_KEY ?? "" },
}`,
  },
  github: {
    provider: "github",
    displayName: "GitHub (Octokit)",
    packages: ["octokit", "@octokit/rest", "@octokit/core"],
    constructors: ["Octokit"],
    apiHosts: ["api.github.com"],
    methods: [
      {
        pattern: /\.repos\.get\s*\(/,
        meridian: "meridian.github.get(`/repos/${owner}/${repo}`)",
        manual: "owner/repo move from named arguments into the endpoint path.",
      },
      {
        pattern: /\.issues\.create\s*\(/,
        meridian:
          "meridian.github.post(`/repos/${owner}/${repo}/issues`, { body: { title, body } })",
        manual: "owner/repo move from named arguments into the endpoint path.",
      },
      {
        pattern: /\.pulls\.list\s*\(/,
        meridian: "meridian.github.paginate(`/repos/${owner}/${repo}/pulls`)",
        manual: "owner/repo move into the path; use paginate() for auto-pagination.",
      },
      {
        pattern: /\.request\s*\(\s*["'`](GET|POST|PUT|PATCH|DELETE)\s/,
        meridian: 'meridian.github.<method>("<same path>")',
      },
    ],
    configSnippet: `github: {
  auth: { token: process.env.GITHUB_TOKEN ?? "" },
}`,
  },
  twilio: {
    provider: "twilio",
    displayName: "Twilio",
    packages: ["twilio"],
    constructors: ["Twilio"],
    apiHosts: ["api.twilio.com"],
    methods: [
      {
        pattern: /\.messages\.create\s*\(/,
        meridian:
          "meridian.twilio.post(`/2010-04-01/Accounts/${accountSid}/Messages.json`, { body: { To, From, Body } })",
        manual: "Twilio's REST API takes form-style fields; the account SID moves into the path.",
      },
    ],
    configSnippet: `twilio: {
  auth: {
    username: process.env.TWILIO_ACCOUNT_SID ?? "",
    password: process.env.TWILIO_AUTH_TOKEN ?? "",
  },
}`,
  },
  sendgrid: {
    provider: "sendgrid",
    displayName: "SendGrid",
    packages: ["@sendgrid/mail", "@sendgrid/client"],
    constructors: [],
    apiHosts: ["api.sendgrid.com"],
    methods: [
      {
        pattern: /sgMail\.send\s*\(/,
        meridian: 'meridian.sendgrid.post("/v3/mail/send", { body: { …same payload… } })',
      },
    ],
    configSnippet: `sendgrid: {
  auth: { apiKey: process.env.SENDGRID_API_KEY ?? "" },
}`,
  },
  razorpay: {
    provider: "razorpay",
    displayName: "Razorpay",
    packages: ["razorpay"],
    constructors: ["Razorpay"],
    apiHosts: ["api.razorpay.com"],
    methods: [
      {
        pattern: /\.orders\.create\s*\(/,
        meridian: 'meridian.razorpay.post("/v1/orders", { body: { …same payload… } })',
      },
      {
        pattern: /\.payments\.fetch\s*\(/,
        meridian: "meridian.razorpay.get(`/v1/payments/${paymentId}`)",
        manual: "The payment id moves from an argument into the endpoint path.",
      },
    ],
    configSnippet: `razorpay: {
  auth: {
    username: process.env.RAZORPAY_KEY_ID ?? "",
    password: process.env.RAZORPAY_KEY_SECRET ?? "",
  },
}`,
  },
};

export function listMigrationProviders(): string[] {
  return Object.keys(MIGRATIONS).sort();
}
