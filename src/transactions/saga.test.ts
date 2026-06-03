import { describe, expect, it, vi } from "vitest";
import type { NormalizedResponse } from "../core/types.js";
import { MeridianError } from "../core/types.js";
import { TransactionError, runTransaction } from "./saga.js";
import type { TransactionStep } from "./saga.js";

const response = (data: unknown = {}): NormalizedResponse<unknown> => ({
  data,
  meta: {
    provider: "test",
    requestId: "r1",
    rateLimit: { limit: 100, remaining: 99, reset: new Date() },
    warnings: [],
    schemaVersion: "1.0",
  },
});

const step = (
  name: string,
  execute: () => Promise<NormalizedResponse<unknown>>,
  rollback?: (r: NormalizedResponse<unknown>) => Promise<void>,
): TransactionStep => ({ name, execute, rollback });

describe("runTransaction", () => {
  it("returns all succeeded steps on full success", async () => {
    const result = await runTransaction([
      step("charge", async () => response({ id: "ch_1" })),
      step("email", async () => response({ id: "em_1" })),
      step("crm", async () => response({ id: "crm_1" })),
    ]);
    expect(result.succeeded).toEqual(["charge", "email", "crm"]);
    expect(result.rolledBack).toEqual([]);
    expect(Object.keys(result.results)).toHaveLength(3);
  });

  it("includes step results in returned object", async () => {
    const result = await runTransaction([step("charge", async () => response({ id: "ch_1" }))]);
    expect((result.results.charge?.data as { id: string }).id).toBe("ch_1");
  });

  it("throws TransactionError when a step fails", async () => {
    await expect(
      runTransaction([
        step("charge", async () => response({ id: "ch_1" })),
        step("email", async () => {
          throw new MeridianError("timeout", "network", "sendgrid", true);
        }),
      ]),
    ).rejects.toBeInstanceOf(TransactionError);
  });

  it("TransactionError.failed identifies the failing step", async () => {
    try {
      await runTransaction([
        step("charge", async () => response()),
        step("email", async () => {
          throw new Error("smtp down");
        }),
      ]);
    } catch (err) {
      expect(err).toBeInstanceOf(TransactionError);
      expect((err as TransactionError).failed).toBe("email");
    }
  });

  it("rolls back previous steps in reverse order", async () => {
    const rollbacks: string[] = [];
    try {
      await runTransaction([
        step(
          "charge",
          async () => response({ id: "ch_1" }),
          async () => {
            rollbacks.push("charge-rb");
          },
        ),
        step(
          "email",
          async () => response({ id: "em_1" }),
          async () => {
            rollbacks.push("email-rb");
          },
        ),
        step("crm", async () => {
          throw new Error("crm fail");
        }),
      ]);
    } catch {}
    expect(rollbacks).toEqual(["email-rb", "charge-rb"]);
  });

  it("TransactionError.rolledBack lists rolled-back steps", async () => {
    const rb = vi.fn().mockResolvedValue(undefined);
    try {
      await runTransaction([
        step("charge", async () => response(), rb),
        step("email", async () => {
          throw new Error("fail");
        }),
      ]);
    } catch (err) {
      expect((err as TransactionError).rolledBack).toContain("charge");
    }
  });

  it("skips rollback for steps without a rollback function", async () => {
    const rb = vi.fn().mockResolvedValue(undefined);
    try {
      await runTransaction([
        step("charge", async () => response(), rb),
        step("email", async () => response()), // no rollback
        step("crm", async () => {
          throw new Error("fail");
        }),
      ]);
    } catch (err) {
      expect((err as TransactionError).rolledBack).toContain("charge");
      expect((err as TransactionError).rolledBack).not.toContain("email");
    }
  });

  it("captures rollback errors without masking the original error", async () => {
    try {
      await runTransaction([
        step(
          "charge",
          async () => response({ id: "ch_1" }),
          async () => {
            throw new Error("refund api down");
          },
        ),
        step("email", async () => {
          throw new Error("smtp fail");
        }),
      ]);
    } catch (err) {
      const txErr = err as TransactionError;
      expect(txErr.failed).toBe("email");
      expect(txErr.rollbackErrors.charge).toContain("refund api down");
    }
  });

  it("TransactionError.succeeded contains steps before failure", async () => {
    try {
      await runTransaction([
        step("a", async () => response()),
        step("b", async () => response()),
        step("c", async () => {
          throw new Error("c fails");
        }),
      ]);
    } catch (err) {
      expect((err as TransactionError).succeeded).toEqual(["a", "b"]);
    }
  });

  it("handles first step failure — no rollbacks needed", async () => {
    try {
      await runTransaction([
        step("charge", async () => {
          throw new Error("instant fail");
        }),
        step("email", async () => response()),
      ]);
    } catch (err) {
      const txErr = err as TransactionError;
      expect(txErr.failed).toBe("charge");
      expect(txErr.rolledBack).toEqual([]);
      expect(txErr.succeeded).toEqual([]);
    }
  });

  it("empty steps array resolves immediately", async () => {
    const result = await runTransaction([]);
    expect(result.succeeded).toEqual([]);
    expect(result.rolledBack).toEqual([]);
  });
});
