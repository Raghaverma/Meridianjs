import { describe, expect, it } from "vitest";
import { IdempotencyLevel } from "../core/types.js";
import { IdempotencyResolver } from "./idempotency.js";

describe("IdempotencyResolver.getIdempotencyLevel", () => {
  it("treats GET/HEAD/OPTIONS as SAFE by default", () => {
    const r = new IdempotencyResolver({});
    expect(r.getIdempotencyLevel("GET", "/x", {})).toBe(IdempotencyLevel.SAFE);
    expect(r.getIdempotencyLevel("HEAD", "/x", {})).toBe(IdempotencyLevel.SAFE);
  });

  it("matches :param override patterns against concrete paths", () => {
    const r = new IdempotencyResolver({
      operationOverrides: new Map([["POST /users/:id/pay", IdempotencyLevel.IDEMPOTENT]]),
    });
    expect(r.getIdempotencyLevel("POST", "/users/42/pay", {})).toBe(IdempotencyLevel.IDEMPOTENT);
    // ":id" is one path segment only — must not cross slashes.
    expect(r.getIdempotencyLevel("POST", "/users/42/extra/pay", {})).not.toBe(
      IdempotencyLevel.IDEMPOTENT,
    );
  });

  it("does not crash on override patterns containing regex metacharacters", () => {
    // Regression: an unbalanced paren used to throw from `new RegExp`, taking
    // down every request that hit the idempotency lookup.
    const r = new IdempotencyResolver({
      operationOverrides: new Map([
        ["POST /charge(v2", IdempotencyLevel.IDEMPOTENT],
        ["POST /a+b[", IdempotencyLevel.UNSAFE],
      ]),
    });
    expect(() => r.getIdempotencyLevel("GET", "/users", {})).not.toThrow();
    // Metacharacters are matched literally, not as regex operators.
    expect(r.getIdempotencyLevel("POST", "/charge(v2", {})).toBe(IdempotencyLevel.IDEMPOTENT);
    expect(r.getIdempotencyLevel("POST", "/charge", {})).not.toBe(IdempotencyLevel.IDEMPOTENT);
  });
});
