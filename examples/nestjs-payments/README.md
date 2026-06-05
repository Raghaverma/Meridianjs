# nestjs-payments

NestJS module that injects Meridian as a provider for a payments service with
Stripe/Razorpay weighted routing and saga-based charge + notification transactions.

## What it demonstrates

- Registering Meridian as an async NestJS provider
- Weighted routing — 70% Stripe, 30% Razorpay — via `meridian.service("payments")`
- `meridian.transaction()` saga: charge → email confirmation, with rollback on failure
- Injectable `PaymentsService` with `charge()` and `refund()` methods
- REST controller wiring charge and refund endpoints

## Environment variables

```
STRIPE_SECRET_KEY=sk_test_...
RAZORPAY_KEY_ID=rzp_test_...
RAZORPAY_KEY_SECRET=...
SENDGRID_API_KEY=SG....
```

## Setup

```bash
npm install meridianjs @nestjs/common @nestjs/core @nestjs/platform-express reflect-metadata rxjs
npm install -D ts-node typescript @types/node
```

Bootstrap with NestJS CLI or add the module to your existing `AppModule`:

```typescript
import { PaymentsModule } from "./payments.module";

@Module({ imports: [PaymentsModule] })
export class AppModule {}
```

Then run:

```bash
npx ts-node -r tsconfig-paths/register src/main.ts
```

## Endpoints

| Method | Path                    | Description            |
|--------|-------------------------|------------------------|
| POST   | /payments/charge        | Charge + email saga    |
| POST   | /payments/refund/:id    | Refund a charge        |
