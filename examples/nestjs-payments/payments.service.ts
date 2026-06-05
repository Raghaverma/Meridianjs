import { Inject, Injectable, Logger } from "@nestjs/common";
import { Meridian, MeridianError, TransactionError } from "meridianjs";
import { MERIDIAN_TOKEN } from "./payments.module";

type MeridianInstance = Awaited<ReturnType<typeof Meridian.create>>;

interface ChargeResult {
  chargeId: string;
  provider: string;
  amount: number;
  currency: string;
  emailSent: boolean;
}

interface RefundResult {
  refundId: string;
  provider: string;
}

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(@Inject(MERIDIAN_TOKEN) private readonly meridian: MeridianInstance) {}

  /**
   * Charges a customer and sends a confirmation email in a single saga.
   * If the email step fails, the charge is automatically refunded.
   */
  async charge(amount: number, currency: string, customerId: string): Promise<ChargeResult> {
    let chargeId = "";
    let usedProvider = "";

    try {
      const result = await this.meridian.transaction([
        {
          name: "charge",
          execute: async () => {
            const payments = this.meridian.service("payments")!;
            const response = await payments.post<{ id: string }>("/v1/charges", {
              body: { amount, currency, customer: customerId, description: "NestJS payment" },
            });
            chargeId = (response.data as { id: string }).id;
            usedProvider = response.meta.provider;
            this.logger.log(`Charge ${chargeId} via ${usedProvider} (${response.meta.trace.latency}ms)`);
            return response;
          },
          rollback: async (r) => {
            const id = (r.data as { id: string }).id;
            this.logger.warn(`Rolling back charge ${id}`);
            await this.meridian.provider("stripe")!.post(`/v1/charges/${id}/refunds`);
          },
        },
        {
          name: "email",
          execute: async () => {
            return this.meridian.provider("sendgrid")!.post("/v3/mail/send", {
              body: {
                personalizations: [{ to: [{ email: `${customerId}@example.com` }] }],
                from: { email: "billing@example.com" },
                subject: "Payment confirmed",
                content: [{ type: "text/plain", value: `Charged ${amount} ${currency.toUpperCase()}` }],
              },
            });
          },
          // No rollback — cannot unsend email; idempotency is acceptable here
        },
      ]);

      return {
        chargeId,
        provider: usedProvider,
        amount,
        currency,
        emailSent: "email" in result.results,
      };
    } catch (err) {
      if (err instanceof TransactionError) {
        this.logger.error(`Transaction failed at step="${err.failed}", rolled back: [${err.rolledBack.join(", ")}]`);
        throw new Error(`Payment failed at step "${err.failed}": ${err.message}`);
      }
      if (err instanceof MeridianError) {
        this.logger.error(`MeridianError [${err.category}] from ${err.provider}: ${err.message}`);
        throw err;
      }
      throw err;
    }
  }

  /**
   * Issues a full refund for an existing charge via the payments service.
   */
  async refund(chargeId: string): Promise<RefundResult> {
    const payments = this.meridian.service("payments")!;

    const { data, meta } = await payments.post<{ id: string }>(`/v1/charges/${chargeId}/refunds`);

    this.logger.log(`Refund ${(data as { id: string }).id} via ${meta.provider}`);

    return {
      refundId: (data as { id: string }).id,
      provider: meta.provider,
    };
  }
}
