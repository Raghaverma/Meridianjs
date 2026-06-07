import { describe, expect, it } from "vitest";
import { signSigV4 } from "./sigv4.js";

// Fixed credentials/date from AWS's published SigV4 test suite
// (https://docs.aws.amazon.com/general/latest/gr/signature-v4-test-suite.html);
// the expected signature below is a golden value for *this* implementation
// (which, unlike the "get-vanilla" example, also signs x-amz-content-sha256),
// pinned to guard against accidental changes to the canonical-request construction.
describe("signSigV4", () => {
  const credentials = {
    accessKeyId: "AKIDEXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
    region: "us-east-1",
    service: "service",
  };
  const date = new Date("2015-08-30T12:36:00Z");

  it("produces the documented signature for a vanilla GET request", () => {
    const url = new URL("https://example.amazonaws.com/");
    const signed = signSigV4({ method: "GET", url, headers: {}, credentials, date });

    expect(signed.headers["x-amz-date"]).toBe("20150830T123600Z");
    expect(signed.headers.Authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, " +
        "SignedHeaders=host;x-amz-content-sha256;x-amz-date, " +
        "Signature=726c5c4879a6b4ccbbd3b24edbd6b8826d34f87450fbbf4e85546fc7ba9c1642",
    );
  });

  it("includes a session token header and signed-header entry when provided", () => {
    const url = new URL("https://example.amazonaws.com/object.txt");
    const signed = signSigV4({
      method: "GET",
      url,
      headers: {},
      credentials: { ...credentials, sessionToken: "TOKEN123" },
      date,
    });

    expect(signed.headers["x-amz-security-token"]).toBe("TOKEN123");
    expect(signed.headers.Authorization).toContain("x-amz-security-token");
  });

  it("changes the signature when the body changes", () => {
    const url = new URL("https://example.amazonaws.com/upload");
    const a = signSigV4({ method: "PUT", url, headers: {}, body: "hello", credentials, date });
    const b = signSigV4({ method: "PUT", url, headers: {}, body: "world", credentials, date });

    expect(a.headers["x-amz-content-sha256"]).not.toBe(b.headers["x-amz-content-sha256"]);
    expect(a.headers.Authorization).not.toBe(b.headers.Authorization);
  });

  it("produces a stable signature for identical inputs", () => {
    const url = new URL("https://example.amazonaws.com/bucket?list-type=2&prefix=a/b");
    const a = signSigV4({ method: "GET", url, headers: {}, credentials, date });
    const b = signSigV4({ method: "GET", url, headers: {}, credentials, date });
    expect(a.headers.Authorization).toBe(b.headers.Authorization);
  });
});
