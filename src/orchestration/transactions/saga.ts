import type { NormalizedResponse } from "../core/types.js";
import { MeridianError } from "../core/types.js";

export interface TransactionStep<T = unknown> {
  name: string;
  execute: () => Promise<NormalizedResponse<T>>;
  rollback?: (result: NormalizedResponse<T>) => Promise<void>;
}

export interface TransactionResult {
  succeeded: string[];
  rolledBack: string[];
  results: Record<string, NormalizedResponse<unknown>>;
}

export class TransactionError extends Error {
  constructor(
    message: string,
    public readonly failed: string,
    public readonly succeeded: string[],
    public readonly rolledBack: string[],
    public readonly rollbackErrors: Record<string, string>,
    public readonly results: Record<string, NormalizedResponse<unknown>>,
    public readonly cause: unknown,
  ) {
    super(message);
    this.name = "TransactionError";
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, TransactionError);
    }
  }
}

export async function runTransaction(steps: TransactionStep[]): Promise<TransactionResult> {
  const succeeded: string[] = [];
  const results: Record<string, NormalizedResponse<unknown>> = {};

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    try {
      const result = await step.execute();
      succeeded.push(step.name);
      results[step.name] = result;
    } catch (err) {
      // Step failed — run compensating rollbacks in reverse order
      const rolledBack: string[] = [];
      const rollbackErrors: Record<string, string> = {};

      for (let j = i - 1; j >= 0; j--) {
        const prev = steps[j]!;
        if (prev.rollback && results[prev.name]) {
          try {
            await prev.rollback(results[prev.name]!);
            rolledBack.push(prev.name);
          } catch (rbErr) {
            rollbackErrors[prev.name] = rbErr instanceof Error ? rbErr.message : String(rbErr);
          }
        }
      }

      const cause = err instanceof MeridianError ? err : err;
      const message = `Transaction failed at step "${step.name}": ${err instanceof Error ? err.message : String(err)}${rolledBack.length > 0 ? `. Rolled back: [${rolledBack.join(", ")}]` : ""}${
        Object.keys(rollbackErrors).length > 0
          ? `. Rollback errors: ${JSON.stringify(rollbackErrors)}`
          : ""
      }`;

      throw new TransactionError(
        message,
        step.name,
        succeeded,
        rolledBack,
        rollbackErrors,
        results,
        cause,
      );
    }
  }

  return { succeeded, rolledBack: [], results };
}
