import type { ProviderAdapter } from "../core/types.js";
import { AnthropicAdapter } from "./ai/anthropic/adapter.js";
import { CohereAdapter } from "./ai/cohere/adapter.js";
import { GeminiAdapter } from "./ai/gemini/adapter.js";
import { MistralAdapter } from "./ai/mistral/adapter.js";
import { OpenAIAdapter } from "./ai/openai/adapter.js";
import { GitHubAdapter } from "./crm/github/adapter.js";
import { HubSpotAdapter } from "./crm/hubspot/adapter.js";
import { HunterAdapter } from "./crm/hunter/adapter.js";
import { ApolloAdapter } from "./healthcare/apollo/adapter.js";
import { Auth0Adapter } from "./identity/auth0/adapter.js";
import { DecentroAdapter } from "./identity/decentro/adapter.js";
import { DigioAdapter } from "./identity/digio/adapter.js";
import { HyperVergeAdapter } from "./identity/hyperverge/adapter.js";
import { IdfyAdapter } from "./identity/idfy/adapter.js";
import { KarzaAdapter } from "./identity/karza/adapter.js";
import { PerfiosAdapter } from "./identity/perfios/adapter.js";
import { SetuAdapter } from "./identity/setu/adapter.js";
import { DelhiveryAdapter } from "./logistics/delhivery/adapter.js";
import { ShiprocketAdapter } from "./logistics/shiprocket/adapter.js";
import { GoogleMapsAdapter } from "./maps/googlemaps/adapter.js";
import { MapmyindiaAdapter } from "./maps/mapmyindia/adapter.js";
import { ExotelAdapter } from "./messaging/exotel/adapter.js";
import { GupshupAdapter } from "./messaging/gupshup/adapter.js";
import { MailgunAdapter } from "./messaging/mailgun/adapter.js";
import { Msg91Adapter } from "./messaging/msg91/adapter.js";
import { SendgridAdapter } from "./messaging/sendgrid/adapter.js";
import { TwilioAdapter } from "./messaging/twilio/adapter.js";
import { VonageAdapter } from "./messaging/vonage/adapter.js";
import { DatadogAdapter } from "./monitoring/datadog/adapter.js";
import { SentryAdapter } from "./monitoring/sentry/adapter.js";
import { AdyenAdapter } from "./payments/adyen/adapter.js";
import { BilldeskAdapter } from "./payments/billdesk/adapter.js";
import { BraintreeAdapter } from "./payments/braintree/adapter.js";
import { CashfreeAdapter } from "./payments/cashfree/adapter.js";
import { CcavenueAdapter } from "./payments/ccavenue/adapter.js";
import { CheckoutAdapter } from "./payments/checkout/adapter.js";
import { JuspayAdapter } from "./payments/juspay/adapter.js";
import { KlarnaAdapter } from "./payments/klarna/adapter.js";
import { MollieAdapter } from "./payments/mollie/adapter.js";
import { PayuAdapter } from "./payments/payu/adapter.js";
import { PhonePeAdapter } from "./payments/phonepe/adapter.js";
import { RazorpayAdapter } from "./payments/razorpay/adapter.js";
import { StripeAdapter } from "./payments/stripe/adapter.js";
import { S3Adapter } from "./storage/s3/adapter.js";
import { SupabaseAdapter } from "./storage/supabase/adapter.js";
import { CleartaxAdapter } from "./tax/cleartax/adapter.js";

/**
 * Eagerly-imported map of every built-in adapter class, keyed by provider
 * name. Test-only: production code resolves adapters lazily via
 * `BUILTIN_ADAPTER_LOADERS` in src/index.ts so that `import "meridianjs"`
 * doesn't pull in all 46 provider SDK clients. This module exists so
 * contract/parity tests can synchronously enumerate and instantiate every
 * adapter without paying that cost in the runtime entrypoint.
 */
export const ALL_ADAPTER_CLASSES: Record<string, new () => ProviderAdapter> = {
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
