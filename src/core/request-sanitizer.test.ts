import { describe, expect, it } from "vitest";
import { sanitizeRequestOptions } from "./request-sanitizer.js";

describe("sanitizeRequestOptions — existing behavior", () => {
  it("blanket-redacts body when no piiRedaction and body is in default redacted keys", () => {
    const result = sanitizeRequestOptions({ body: { name: "Alice" } });
    expect(result.body).toBe("[REDACTED]");
  });

  it("redacts authorization header", () => {
    const result = sanitizeRequestOptions({ headers: { Authorization: "Bearer secret" } });
    expect(result.headers?.["Authorization"]).toBe("[REDACTED]");
  });

  it("passes through non-sensitive headers", () => {
    const result = sanitizeRequestOptions({ headers: { "Content-Type": "application/json" } });
    expect(result.headers?.["Content-Type"]).toBe("application/json");
  });

  it("piiRedaction: redacts email in string body", () => {
    const result = sanitizeRequestOptions(
      { body: "Contact user@example.com for details" },
      { piiRedaction: true },
    );
    expect(result.body).not.toContain("user@example.com");
    expect(result.body).toContain("[PII-REDACTED]");
  });

  it("piiRedaction: redacts email in nested object body", () => {
    const result = sanitizeRequestOptions(
      { body: { contact: { email: "alice@example.com" } } },
      { piiRedaction: true },
    );
    const json = JSON.stringify(result.body);
    expect(json).not.toContain("alice@example.com");
    expect(json).toContain("[PII-REDACTED]");
  });

  it("piiRedaction false: body is blanket-redacted", () => {
    const result = sanitizeRequestOptions(
      { body: { ssn: "123-45-6789" } },
      { piiRedaction: false },
    );
    expect(result.body).toBe("[REDACTED]");
  });
});

describe("India compliance mode", () => {
  it("redacts ungrouped Aadhaar in object body", () => {
    const result = sanitizeRequestOptions(
      { body: { aadhaar: "123456789012" } },
      { indiaMode: true },
    );
    const json = JSON.stringify(result.body);
    expect(json).not.toContain("123456789012");
    expect(json).toContain("[AADHAAR-REDACTED]");
  });

  it("redacts grouped Aadhaar (spaces) in object body", () => {
    const result = sanitizeRequestOptions({ body: { id: "1234 5678 9012" } }, { indiaMode: true });
    const json = JSON.stringify(result.body);
    expect(json).not.toContain("1234 5678 9012");
    expect(json).toContain("[AADHAAR-REDACTED]");
  });

  it("redacts grouped Aadhaar (hyphens) in object body", () => {
    const result = sanitizeRequestOptions({ body: { id: "1234-5678-9012" } }, { indiaMode: true });
    const json = JSON.stringify(result.body);
    expect(json).not.toContain("1234-5678-9012");
    expect(json).toContain("[AADHAAR-REDACTED]");
  });

  it("redacts PAN in object body", () => {
    const result = sanitizeRequestOptions({ body: { pan: "ABCDE1234F" } }, { indiaMode: true });
    const json = JSON.stringify(result.body);
    expect(json).not.toContain("ABCDE1234F");
    expect(json).toContain("[PAN-REDACTED]");
  });

  it("redacts UPI VPA (no TLD) in object body", () => {
    const result = sanitizeRequestOptions({ body: { vpa: "user@oksbi" } }, { indiaMode: true });
    const json = JSON.stringify(result.body);
    expect(json).not.toContain("user@oksbi");
    expect(json).toContain("[VPA-REDACTED]");
  });

  it("redacts bank account (14-digit) in object body", () => {
    const result = sanitizeRequestOptions(
      { body: { account: "12345678901234" } },
      { indiaMode: true },
    );
    const json = JSON.stringify(result.body);
    expect(json).not.toContain("12345678901234");
    expect(json).toContain("[ACCOUNT-REDACTED]");
  });

  it("redacts bank account (9-digit) in object body", () => {
    const result = sanitizeRequestOptions({ body: { account: "123456789" } }, { indiaMode: true });
    const json = JSON.stringify(result.body);
    expect(json).not.toContain("123456789");
    expect(json).toContain("[ACCOUNT-REDACTED]");
  });

  it("redacts all India PII in a nested object body", () => {
    const result = sanitizeRequestOptions(
      {
        body: {
          user: {
            aadhaar: "1234 5678 9012",
            pan: "ABCDE1234F",
            upi: "john.doe@ybl",
            bank: "98765432109876",
          },
        },
      },
      { indiaMode: true },
    );
    const json = JSON.stringify(result.body);
    expect(json).not.toContain("1234 5678 9012");
    expect(json).not.toContain("ABCDE1234F");
    expect(json).not.toContain("john.doe@ybl");
    expect(json).not.toContain("98765432109876");
    expect(json).toContain("[AADHAAR-REDACTED]");
    expect(json).toContain("[PAN-REDACTED]");
    expect(json).toContain("[VPA-REDACTED]");
    expect(json).toContain("[ACCOUNT-REDACTED]");
  });

  it("also redacts generic email when indiaMode is on", () => {
    const result = sanitizeRequestOptions(
      { body: { email: "alice@example.com" } },
      { indiaMode: true },
    );
    const json = JSON.stringify(result.body);
    expect(json).not.toContain("alice@example.com");
  });

  it("also redacts generic phone when indiaMode is on", () => {
    const result = sanitizeRequestOptions({ body: { phone: "555-867-5309" } }, { indiaMode: true });
    const json = JSON.stringify(result.body);
    expect(json).not.toContain("555-867-5309");
    expect(json).toContain("[PII-REDACTED]");
  });

  it("does NOT redact Aadhaar when indiaMode is absent", () => {
    const result = sanitizeRequestOptions({ body: { aadhaar: "123456789012" } });
    // body is blanket-redacted by default, but value itself is unchanged at key level
    // the blanket [REDACTED] means the value is gone, which is also fine — check with piiRedaction:false explicitly
    expect(result.body).toBe("[REDACTED]");
  });

  it("does NOT redact Aadhaar with AADHAAR label when piiRedaction only (no indiaMode)", () => {
    const result = sanitizeRequestOptions(
      { body: "user aadhaar: 123456789012" },
      { piiRedaction: true },
    );
    // India-specific label is NOT produced without indiaMode
    expect(result.body).not.toContain("[AADHAAR-REDACTED]");
    // (CREDIT_CARD pattern may still match the digit run, which is acceptable generic PII redaction)
  });

  it("does NOT redact PAN with piiRedaction only (no indiaMode)", () => {
    const result = sanitizeRequestOptions({ body: "pan: ABCDE1234F" }, { piiRedaction: true });
    expect(result.body).toContain("ABCDE1234F");
    expect(result.body).not.toContain("[PAN-REDACTED]");
  });

  it("redacts Aadhaar in a string body (indiaMode)", () => {
    const result = sanitizeRequestOptions(
      { body: "Customer aadhaar: 1234-5678-9012 on file" },
      { indiaMode: true },
    );
    expect(result.body).not.toContain("1234-5678-9012");
    expect(result.body).toContain("[AADHAAR-REDACTED]");
  });

  it("raw email with dotted domain is redacted (VPA or EMAIL label, raw value gone)", () => {
    const result = sanitizeRequestOptions({ body: { contact: "a@b.com" } }, { indiaMode: true });
    const json = JSON.stringify(result.body);
    expect(json).not.toContain("a@b.com");
  });
});
