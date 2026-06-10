import { describe, expect, it } from "vitest";
import { assertSafeEndpoint, isSafeEndpoint } from "./endpoint-validator.js";
import { MeridianError } from "./types.js";

describe("isSafeEndpoint — rejects host-override vectors", () => {
  const dangerous: Array<[string, string]> = [
    ["absolute https URL", "https://evil.com"],
    ["absolute http URL", "http://evil.com/v1/charges"],
    ["uppercase scheme", "HTTP://evil.com"],
    ["mixed-case scheme", "HtTpS://evil.com"],
    ["non-http scheme", "mailto:attacker@evil.com"],
    ["file scheme", "file:///etc/passwd"],
    ["protocol-relative", "//evil.com/x"],
    ["leading-space smuggling", "  https://evil.com"],
    ["tab smuggling", `ht${String.fromCharCode(9)}tps://evil.com`],
    ["newline smuggling", `htt${String.fromCharCode(10)}ps://evil.com`],
    ["carriage-return smuggling", `htt${String.fromCharCode(13)}ps://evil.com`],
    ["null-byte smuggling", `https:${String.fromCharCode(0)}//evil.com`],
    ["double backslash", "\\\\evil.com"],
    ["slash-backslash", "/\\evil.com"],
    ["backslash-slash", "\\/evil.com"],
    ["scheme with backslashes", "https:\\\\evil.com"],
    ["scheme single-slash relative form", "https:/evil.com"],
    ["scheme no-slash form", "https:evil.com"],
  ];

  for (const [label, value] of dangerous) {
    it(`rejects ${label}`, () => {
      expect(isSafeEndpoint(value)).toBe(false);
    });
  }

  it("rejects non-string input", () => {
    expect(isSafeEndpoint(undefined)).toBe(false);
    expect(isSafeEndpoint(null)).toBe(false);
    expect(isSafeEndpoint(42)).toBe(false);
    expect(isSafeEndpoint({})).toBe(false);
  });
});

describe("isSafeEndpoint — allows ordinary relative references", () => {
  const safe: string[] = [
    "/v1/charges",
    "v1/charges",
    "/v1/customers/cus_123",
    "/v1/foo:bar",
    "/messages?model=claude:latest",
    "?page=2",
    "#fragment",
    "/",
    "",
    "/path/with/../traversal",
    "/search?q=a@b.com",
  ];

  for (const value of safe) {
    it(`allows ${JSON.stringify(value)}`, () => {
      expect(isSafeEndpoint(value)).toBe(true);
    });
  }
});

describe("assertSafeEndpoint", () => {
  it("throws a MeridianError with category 'validation' for unsafe endpoints", () => {
    try {
      assertSafeEndpoint("https://evil.com", "stripe", "req-1");
      throw new Error("expected assertSafeEndpoint to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(MeridianError);
      const me = err as MeridianError;
      expect(me.category).toBe("validation");
      expect(me.provider).toBe("stripe");
      expect(me.requestId).toBe("req-1");
      expect(me.retryable).toBe(false);
    }
  });

  it("does not throw for safe endpoints", () => {
    expect(() => assertSafeEndpoint("/v1/charges", "stripe")).not.toThrow();
  });

  it("the resolved origin always matches the base for accepted endpoints", () => {
    // Cross-check the validator against the actual URL parser: any endpoint it
    // accepts must resolve to the base origin, and any it rejects must not be
    // silently trusted.
    const base = "https://api.stripe.com";
    const samples = [
      "https://evil.com",
      "//evil.com/x",
      "\\\\evil.com",
      "/v1/charges",
      "v1/charges",
      "?page=2",
    ];
    for (const s of samples) {
      if (isSafeEndpoint(s)) {
        expect(new URL(s, base).origin).toBe("https://api.stripe.com");
      }
    }
  });
});
