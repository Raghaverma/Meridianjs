import { Module } from "@nestjs/common";
import { Meridian, blockPII } from "meridianjs";
import { PaymentsController } from "./payments.controller";
import { PaymentsService } from "./payments.service";

// MERIDIAN_TOKEN is the injection token used to provide the Meridian instance
// across this module. Using a symbol avoids class-name collisions.
export const MERIDIAN_TOKEN = Symbol("MERIDIAN");

@Module({
  controllers: [PaymentsController],
  providers: [
    {
      provide: MERIDIAN_TOKEN,
      useFactory: async (): Promise<Awaited<ReturnType<typeof Meridian.create>>> => {
        return Meridian.create({
          localUnsafe: true,
          providers: {
            stripe: {
              auth: { apiKey: process.env.STRIPE_SECRET_KEY ?? "" },
            },
            razorpay: {
              auth: {
                apiKey: process.env.RAZORPAY_KEY_ID ?? "",
                token: process.env.RAZORPAY_KEY_SECRET ?? "",
              },
            },
            sendgrid: {
              auth: { apiKey: process.env.SENDGRID_API_KEY ?? "" },
            },
          },
          services: {
            payments: {
              providers: ["stripe", "razorpay"],
              strategy: "weighted",
              weights: { stripe: 70, razorpay: 30 },
            },
          },
          policies: [blockPII(["stripe", "razorpay"])],
        });
      },
    },
    PaymentsService,
  ],
  exports: [PaymentsService],
})
export class PaymentsModule {}
