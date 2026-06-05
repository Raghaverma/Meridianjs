# express-stripe

Express server that wraps Stripe through Meridian. Shows pagination, idempotent
charges, and a health endpoint — all without touching the Stripe SDK directly.

## What it demonstrates

- `meridian.provider("stripe")` for direct provider access
- `paginate()` async generator for cursor-based list traversal
- Idempotency key forwarding to prevent duplicate charges
- `meridian.health()` surfaced as a JSON health endpoint
- `MeridianError` middleware for structured error responses

## Environment variables

```
STRIPE_SECRET_KEY=sk_test_...
PORT=3001
```

## Setup

```bash
npm install meridianjs express
npm install -D tsx @types/express
```

Run the server:

```bash
npx tsx server.ts
```

## Endpoints

| Method | Path            | Description                              |
|--------|-----------------|------------------------------------------|
| GET    | /customers      | List all customers (paginated)           |
| POST   | /charges        | Create a charge with idempotency         |
| GET    | /health         | Meridian provider health status          |

## Example requests

```bash
# List customers
curl http://localhost:3001/customers

# Create a charge
curl -X POST http://localhost:3001/charges \
  -H "Content-Type: application/json" \
  -d '{"amount": 2000, "currency": "usd", "source": "tok_visa"}'

# Health check
curl http://localhost:3001/health
```
