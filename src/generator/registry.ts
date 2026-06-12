/**
 * Curated registry of providers with publicly published OpenAPI specs.
 *
 * `meridian add <provider>` resolves the spec URL here so the common case is
 * zero-configuration. Providers without an entry (or whose published spec is
 * YAML-only) can still be generated with an explicit `--openapi <url|path>`.
 *
 * Spec URLs point at the providers' official spec repositories. They are
 * external resources and can move; `meridian add` degrades gracefully with a
 * pointer to `docsUrl` when a download fails.
 */

export interface KnownProviderSpec {
  name: string;
  displayName: string;
  /** URL of the machine-readable OpenAPI document (JSON). */
  specUrl: string;
  /** Human docs, used in error messages when the spec download fails. */
  docsUrl: string;
  /** Base URL override for when the spec omits or misstates `servers`. */
  baseUrl?: string;
  /** Auth override for when the spec's securitySchemes are absent or wrong. */
  auth?: "apiKey" | "bearer" | "basic" | "oauth2";
  notes?: string;
}

export const KNOWN_PROVIDERS: Record<string, KnownProviderSpec> = {
  slack: {
    name: "slack",
    displayName: "Slack Web API",
    specUrl:
      "https://raw.githubusercontent.com/slackapi/slack-api-specs/master/web-api/slack_web_openapi_v2.json",
    docsUrl: "https://api.slack.com/web",
    baseUrl: "https://slack.com/api",
    auth: "bearer",
  },
  github: {
    name: "github",
    displayName: "GitHub REST API",
    specUrl:
      "https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json",
    docsUrl: "https://docs.github.com/rest",
    baseUrl: "https://api.github.com",
    auth: "bearer",
    notes: "Large spec (>10 MB); the download can take a few seconds.",
  },
  stripe: {
    name: "stripe",
    displayName: "Stripe API",
    specUrl: "https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json",
    docsUrl: "https://docs.stripe.com/api",
    baseUrl: "https://api.stripe.com",
    auth: "bearer",
    notes: "Large spec (>5 MB); the download can take a few seconds.",
  },
  twilio: {
    name: "twilio",
    displayName: "Twilio API (v2010)",
    specUrl:
      "https://raw.githubusercontent.com/twilio/twilio-oai/main/spec/json/twilio_api_v2010.json",
    docsUrl: "https://www.twilio.com/docs/usage/api",
    baseUrl: "https://api.twilio.com",
    auth: "basic",
  },
  box: {
    name: "box",
    displayName: "Box Platform API",
    specUrl: "https://raw.githubusercontent.com/box/box-openapi/main/openapi.json",
    docsUrl: "https://developer.box.com/reference",
    baseUrl: "https://api.box.com/2.0",
    auth: "bearer",
  },
  sendgrid: {
    name: "sendgrid",
    displayName: "SendGrid v3 Mail API",
    specUrl:
      "https://raw.githubusercontent.com/sendgrid/sendgrid-oai/main/spec/json/tsg_mail_v3.json",
    docsUrl: "https://www.twilio.com/docs/sendgrid/api-reference",
    baseUrl: "https://api.sendgrid.com",
    auth: "bearer",
  },
};

export function resolveKnownProvider(name: string): KnownProviderSpec | null {
  return KNOWN_PROVIDERS[name.toLowerCase()] ?? null;
}

export function listKnownProviders(): KnownProviderSpec[] {
  return Object.values(KNOWN_PROVIDERS).sort((a, b) => a.name.localeCompare(b.name));
}
