export const PROVIDER_CAPABILITIES: Record<string, string[]> = {
  // AI / LLM
  openai: [
    "chat",
    "completions",
    "embeddings",
    "streaming",
    "vision",
    "image-generation",
    "speech",
    "audio",
  ],
  anthropic: ["chat", "completions", "streaming", "vision"],
  gemini: ["chat", "completions", "streaming", "vision", "embeddings", "image-generation"],
  cohere: ["chat", "completions", "embeddings", "rerank"],
  mistral: ["chat", "completions", "streaming", "embeddings"],

  // Payment
  stripe: ["payments", "subscriptions", "refunds", "invoices", "customers", "payouts"],
  billdesk: ["payments", "mandates", "refunds", "upi", "bill-payments"],
  ccavenue: ["payments", "refunds", "order-tracking", "subscriptions"],
  razorpay: ["payments", "subscriptions", "refunds", "payouts", "invoices", "upi"],
  cashfree: ["payments", "subscriptions", "refunds", "payouts", "upi"],
  payu: ["payments", "refunds", "subscriptions", "emi"],
  juspay: ["payments", "refunds", "order-management", "upi"],
  braintree: ["payments", "subscriptions", "refunds", "customers"],
  adyen: ["payments", "refunds", "payouts", "subscriptions", "fraud-detection"],
  mollie: ["payments", "subscriptions", "refunds", "payouts"],
  klarna: ["payments", "installments", "refunds"],
  phonepe: ["payments", "refunds", "upi", "wallet"],

  // Communication / Messaging
  twilio: ["sms", "voice", "whatsapp", "email", "video", "verify"],
  sendgrid: ["email", "templates", "marketing", "analytics"],
  mailgun: ["email", "templates", "validation", "tracking"],
  vonage: ["sms", "voice", "whatsapp", "video", "verify"],
  msg91: ["sms", "voice", "whatsapp", "email", "otp"],
  gupshup: ["sms", "whatsapp", "rcs", "chatbot"],
  exotel: ["voice", "sms", "ivr", "call-tracking"],

  // KYC / Identity
  hyperverge: ["kyc", "face-match", "document-verification", "ocr", "liveness"],
  digio: ["kyc", "e-sign", "document-verification", "aadhaar"],
  karza: ["kyc", "gst-verification", "pan-verification", "bank-verification"],
  idfy: ["kyc", "document-verification", "face-match", "background-check"],
  setu: ["upi", "bank-verification", "kyc", "bbps", "account-aggregator"],
  decentro: ["payments", "kyc", "bank-verification", "upi", "lending"],
  perfios: ["financial-data", "bank-statement-analysis", "kyc", "credit-decisioning"],

  // Logistics
  shiprocket: ["shipping", "tracking", "pickup", "returns", "cod"],
  delhivery: ["shipping", "tracking", "pickup", "cod", "warehousing"],

  // Maps / Location
  mapmyindia: ["maps", "geocoding", "routing", "places", "navigation"],

  // Tax / Compliance
  cleartax: ["gst-filing", "tax-compliance", "e-invoicing", "tds"],

  // Developer Tools / CRM
  github: ["repos", "pull-requests", "issues", "webhooks", "actions", "packages"],
  hubspot: ["crm", "contacts", "deals", "marketing", "email", "automation"],

  // Auth
  auth0: ["authentication", "authorization", "mfa", "sso", "user-management"],

  // Database / Backend
  supabase: ["database", "realtime", "storage", "auth", "edge-functions"],

  // Observability / Monitoring
  sentry: ["error-tracking", "performance-monitoring", "issues", "alerts", "releases"],
  datadog: ["metrics", "logs", "monitors", "apm", "events", "dashboards"],

  // GraphQL
  apollo: ["graphql", "data-graph", "federation", "schema-registry"],

  // Object Storage
  s3: ["object-storage", "buckets", "presigned-urls", "multipart-upload"],
};

export interface ProviderInfo {
  name: string;
  capabilities: string[];
}
