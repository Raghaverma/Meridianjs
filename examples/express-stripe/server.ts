import express, { type Request, type Response, type NextFunction } from "express";
import { Meridian, MeridianError } from "meridianjs";

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT ?? 3001);

async function bootstrap() {
  const meridian = await Meridian.create({
    localUnsafe: true,
    providers: {
      stripe: {
        auth: { apiKey: process.env.STRIPE_SECRET_KEY ?? "" },
      },
    },
  });

  const stripe = meridian.provider("stripe")!;

  // GET /customers — stream all Stripe customers using the async paginator.
  // Each page is fetched only when the previous one is consumed.
  app.get("/customers", async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const customers: unknown[] = [];

      for await (const page of stripe.paginate("/v1/customers")) {
        const raw = page.data as { data?: unknown[] };
        if (Array.isArray(raw?.data)) {
          customers.push(...raw.data);
        }
        // Stop after 3 pages to keep the demo response small
        if (customers.length >= 300) break;
      }

      res.json({ customers, count: customers.length });
    } catch (err) {
      next(err);
    }
  });

  // POST /charges — create a Stripe charge with an idempotency key so
  // retrying the same request never double-charges.
  app.post("/charges", async (req: Request, res: Response, next: NextFunction) => {
    const { amount, currency, source, idempotencyKey } = req.body as {
      amount?: number;
      currency?: string;
      source?: string;
      idempotencyKey?: string;
    };

    if (!amount || !currency || !source) {
      res.status(400).json({ error: "`amount`, `currency`, and `source` are required" });
      return;
    }

    try {
      const { data, meta } = await stripe.post("/v1/charges", {
        body: { amount, currency, source, description: "Meridian example charge" },
        headers: idempotencyKey
          ? { "Idempotency-Key": idempotencyKey }
          : undefined,
      });

      console.log(`[meridian] charge via provider=${meta.provider}  latency=${meta.trace.latency}ms`);
      res.status(201).json({ charge: data, provider: meta.provider });
    } catch (err) {
      next(err);
    }
  });

  // GET /health — expose Meridian's built-in health snapshot as JSON.
  app.get("/health", (_req: Request, res: Response) => {
    const health = meridian.health();
    const allHealthy = Object.values(health).every((h) => h.status === "healthy");
    res.status(allHealthy ? 200 : 503).json(health);
  });

  // Error-handling middleware — translates MeridianError to a structured JSON response.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof MeridianError) {
      const status =
        err.category === "auth"
          ? 401
          : err.category === "rate_limit"
            ? 429
            : err.category === "validation"
              ? 422
              : 502;

      res.status(status).json({
        error: err.message,
        category: err.category,
        provider: err.provider,
        retryable: err.retryable,
        requestId: err.requestId,
      });
      return;
    }

    console.error("[server] unexpected error", err);
    res.status(500).json({ error: "Internal server error" });
  });

  app.listen(PORT, () => {
    console.log(`express-stripe example listening on http://localhost:${PORT}`);
  });
}

bootstrap().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
