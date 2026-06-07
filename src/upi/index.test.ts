import { describe, expect, it } from "vitest";
import { createUpiDeepLink, validateVpa } from "./index.js";

describe("validateVpa", () => {
  it("accepts well-formed VPAs", () => {
    expect(validateVpa("merchant@oksbi")).toBe(true);
    expect(validateVpa("user.name@upi")).toBe(true);
    expect(validateVpa("9876543210@ybl")).toBe(true);
    expect(validateVpa("user_name-1@paytm")).toBe(true);
  });

  it("trims surrounding whitespace before validating", () => {
    expect(validateVpa("  merchant@oksbi  ")).toBe(true);
  });

  it("rejects malformed VPAs", () => {
    expect(validateVpa("not-a-vpa")).toBe(false);
    expect(validateVpa("@oksbi")).toBe(false);
    expect(validateVpa("merchant@")).toBe(false);
    expect(validateVpa("merchant@1bank")).toBe(false);
    expect(validateVpa("has space@oksbi")).toBe(false);
    expect(validateVpa("")).toBe(false);
  });

  it("rejects non-string input without throwing", () => {
    // @ts-expect-error - exercising runtime guard against non-string input
    expect(validateVpa(12345)).toBe(false);
    // @ts-expect-error - exercising runtime guard against non-string input
    expect(validateVpa(null)).toBe(false);
  });
});

describe("createUpiDeepLink", () => {
  it("builds a minimal upi://pay link with the payee VPA and default currency", () => {
    const link = createUpiDeepLink({ vpa: "merchant@upi" });
    expect(link).toBe("upi://pay?pa=merchant%40upi&cu=INR");
  });

  it("includes optional fields when provided", () => {
    const link = createUpiDeepLink({
      vpa: "merchant@upi",
      payeeName: "Acme Store",
      amount: 1000,
      note: "Order #123",
      transactionRef: "txn-ref-1",
      transactionId: "txn-id-1",
      merchantCode: "1234",
    });

    const url = new URL(link.replace("upi://", "https://"));
    expect(url.searchParams.get("pa")).toBe("merchant@upi");
    expect(url.searchParams.get("pn")).toBe("Acme Store");
    expect(url.searchParams.get("am")).toBe("1000.00");
    expect(url.searchParams.get("cu")).toBe("INR");
    expect(url.searchParams.get("tn")).toBe("Order #123");
    expect(url.searchParams.get("tr")).toBe("txn-ref-1");
    expect(url.searchParams.get("tid")).toBe("txn-id-1");
    expect(url.searchParams.get("mc")).toBe("1234");
  });

  it("formats the amount with two decimal places", () => {
    const link = createUpiDeepLink({ vpa: "merchant@upi", amount: 49.5 });
    expect(link).toContain("am=49.50");
  });

  it("respects a custom currency", () => {
    const link = createUpiDeepLink({ vpa: "merchant@upi", currency: "USD" });
    expect(link).toContain("cu=USD");
  });

  it("percent-encodes special characters in optional fields", () => {
    const link = createUpiDeepLink({ vpa: "merchant@upi", note: "Order #123 & more" });
    expect(link).toContain("tn=Order%20%23123%20%26%20more");
  });

  it("throws for an invalid VPA", () => {
    expect(() => createUpiDeepLink({ vpa: "not-a-vpa" })).toThrow(/valid UPI VPA/);
  });

  it("throws for a non-positive amount", () => {
    expect(() => createUpiDeepLink({ vpa: "merchant@upi", amount: 0 })).toThrow(/positive/);
    expect(() => createUpiDeepLink({ vpa: "merchant@upi", amount: -5 })).toThrow(/positive/);
  });

  it("throws for a non-finite amount", () => {
    expect(() => createUpiDeepLink({ vpa: "merchant@upi", amount: Number.NaN })).toThrow(
      /positive finite/,
    );
    expect(() =>
      createUpiDeepLink({ vpa: "merchant@upi", amount: Number.POSITIVE_INFINITY }),
    ).toThrow(/positive finite/);
  });
});
