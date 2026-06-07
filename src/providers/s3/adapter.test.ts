import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { MeridianError, RawResponse } from "../../core/types.js";
import { S3Adapter } from "./adapter.js";

const LIST_OBJECTS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <IsTruncated>true</IsTruncated>
  <NextContinuationToken>token_abc</NextContinuationToken>
  <KeyCount>5</KeyCount>
  <Contents><Key>a.txt</Key></Contents>
</ListBucketResult>`;

const ERROR_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Error>
  <Code>NoSuchBucket</Code>
  <Message>The specified bucket does not exist</Message>
  <RequestId>req-123</RequestId>
  <Resource>/missing-bucket</Resource>
</Error>`;

describe("S3Adapter - Contract Tests", () => {
  const adapter = new S3Adapter("https://s3.amazonaws.com/");

  describe("buildRequest", () => {
    it("should sign requests with AWS Signature Version 4", async () => {
      const token = await adapter.authStrategy({
        username: "AKIDEXAMPLE",
        password: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
        custom: { region: "us-east-1" },
      });
      const built = adapter.buildRequest({
        endpoint: "my-bucket/my-key.txt",
        options: { method: "GET" },
        authToken: token,
      });

      expect(built.headers.Authorization).toContain("AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/");
      expect(built.headers.Authorization).toContain("us-east-1/s3/aws4_request");
      expect(built.headers["x-amz-date"]).toMatch(/^\d{8}T\d{6}Z$/);
      expect(built.headers["x-amz-content-sha256"]).toMatch(/^[0-9a-f]{64}$/);
      expect(built.headers.host).toBe("s3.amazonaws.com");
    });

    it("should include the session token header when present", async () => {
      const token = await adapter.authStrategy({
        username: "AKID",
        password: "secret",
        custom: { region: "us-east-1", sessionToken: "TOKEN123" },
      });
      const built = adapter.buildRequest({
        endpoint: "my-bucket/key",
        options: { method: "GET" },
        authToken: token,
      });
      expect(built.headers["x-amz-security-token"]).toBe("TOKEN123");
      expect(built.headers.Authorization).toContain("x-amz-security-token");
    });

    it("should append query params to the URL", async () => {
      const token = await adapter.authStrategy({ username: "AKID", password: "secret" });
      const built = adapter.buildRequest({
        endpoint: "my-bucket",
        options: { method: "GET", query: { "list-type": "2", prefix: "logs/" } },
        authToken: token,
      });
      expect(built.url).toContain("list-type=2");
      expect(built.url).toContain("prefix=logs%2F");
    });

    it("should include a body and Content-Type for non-GET requests", async () => {
      const token = await adapter.authStrategy({ username: "AKID", password: "secret" });
      const built = adapter.buildRequest({
        endpoint: "my-bucket/object.json",
        options: { method: "PUT", body: { hello: "world" } },
        authToken: token,
      });
      expect(built.body).toBe('{"hello":"world"}');
      expect(built.headers["Content-Type"]).toBe("application/octet-stream");
    });

    it("should not include a body for GET requests", async () => {
      const token = await adapter.authStrategy({ username: "AKID", password: "secret" });
      const built = adapter.buildRequest({
        endpoint: "my-bucket/object.json",
        options: { method: "GET", body: { ignored: true } },
        authToken: token,
      });
      expect(built.body).toBeUndefined();
    });
  });

  describe("parseResponse", () => {
    it("should normalize a successful response", () => {
      const raw: RawResponse = {
        status: 200,
        headers: new Headers(),
        body: LIST_OBJECTS_XML,
      };
      const normalized = adapter.parseResponse(raw);
      expect(normalized.meta.provider).toBe("s3");
      expect(normalized.meta.rateLimit.reset).toBeInstanceOf(Date);
    });
  });

  describe("parseError", () => {
    it("should map 401/403 to auth category and parse the XML error body", () => {
      const error = adapter.parseError({
        status: 403,
        headers: new Headers(),
        body: ERROR_XML,
      });
      expect(error.category).toBe("auth");
      expect(error.retryable).toBe(false);
      expect(error.provider).toBe("s3");
      expect(error.message).toBe("The specified bucket does not exist");
      expect(error.metadata?.code).toBe("NoSuchBucket");
      expect(error.metadata?.requestId).toBe("req-123");
    });

    it("should map 404 to validation category", () => {
      expect(
        adapter.parseError({ status: 404, headers: new Headers(), body: ERROR_XML }).category,
      ).toBe("validation");
    });

    it("should map 429 to rate_limit category", () => {
      const error = adapter.parseError({ status: 429, headers: new Headers(), body: "" });
      expect(error.category).toBe("rate_limit");
      expect(error.retryable).toBe(true);
    });

    it("should map 503 SlowDown to rate_limit category", () => {
      const slowDownXml =
        "<Error><Code>SlowDown</Code><Message>Please reduce your request rate</Message></Error>";
      const error = adapter.parseError({ status: 503, headers: new Headers(), body: slowDownXml });
      expect(error.category).toBe("rate_limit");
      expect(error.retryable).toBe(true);
    });

    it("should map other 5xx to provider category and mark retryable", () => {
      const error = adapter.parseError({ status: 500, headers: new Headers(), body: "" });
      expect(error.category).toBe("provider");
      expect(error.retryable).toBe(true);
    });

    it("should map 400 to validation category", () => {
      expect(adapter.parseError({ status: 400, headers: new Headers(), body: "" }).category).toBe(
        "validation",
      );
    });

    it("should map network errors to network category", () => {
      expect(adapter.parseError(new Error("ETIMEDOUT")).category).toBe("network");
    });

    it("should always return canonical error categories", () => {
      const cases = [
        { status: 401, expected: "auth" },
        { status: 403, expected: "auth" },
        { status: 404, expected: "validation" },
        { status: 400, expected: "validation" },
        { status: 429, expected: "rate_limit" },
        { status: 500, expected: "provider" },
      ] as const;
      for (const { status, expected } of cases) {
        expect(adapter.parseError({ status, headers: new Headers(), body: "" }).category).toBe(
          expected,
        );
      }
    });
  });

  describe("authStrategy", () => {
    it("should build SigV4 credentials from username/password + custom.region", async () => {
      const token = await adapter.authStrategy({
        username: "AKID",
        password: "secret",
        custom: { region: "auto" },
      });
      const credentials = JSON.parse(token.token);
      expect(credentials).toMatchObject({
        accessKeyId: "AKID",
        secretAccessKey: "secret",
        region: "auto",
        service: "s3",
      });
    });

    it("should fall back to apiKey/apiSecret and default region", async () => {
      const token = await adapter.authStrategy({ apiKey: "AKID2", apiSecret: "secret2" });
      const credentials = JSON.parse(token.token);
      expect(credentials.accessKeyId).toBe("AKID2");
      expect(credentials.secretAccessKey).toBe("secret2");
      expect(credentials.region).toBe("us-east-1");
    });

    it("should throw a MeridianError for missing credentials", async () => {
      await expect(adapter.authStrategy({})).rejects.toThrow();
      try {
        await adapter.authStrategy({});
      } catch (err) {
        expect((err as MeridianError).category).toBe("auth");
      }
    });
  });

  describe("rateLimitPolicy", () => {
    it("should return sensible defaults (S3 publishes no rate-limit headers)", () => {
      const rl = adapter.rateLimitPolicy(new Headers());
      expect(rl.limit).toBeGreaterThan(0);
      expect(rl.remaining).toBeGreaterThanOrEqual(0);
      expect(rl.reset).toBeInstanceOf(Date);
    });
  });

  describe("paginationStrategy (ListObjectsV2 XML)", () => {
    it("should extract the continuation token cursor and total from XML", () => {
      const strategy = adapter.paginationStrategy();
      const raw: RawResponse = { status: 200, headers: new Headers(), body: LIST_OBJECTS_XML };
      expect(strategy.extractCursor(raw)).toBe("token_abc");
      expect(strategy.extractTotal(raw)).toBe(5);
      expect(strategy.hasNext(raw)).toBe(true);
    });

    it("should report no next page when not truncated", () => {
      const strategy = adapter.paginationStrategy();
      const xml = LIST_OBJECTS_XML.replace(
        "<IsTruncated>true</IsTruncated>",
        "<IsTruncated>false</IsTruncated>",
      );
      const raw: RawResponse = { status: 200, headers: new Headers(), body: xml };
      expect(strategy.hasNext(raw)).toBe(false);
    });

    it("should return null/false for non-XML bodies", () => {
      const strategy = adapter.paginationStrategy();
      const raw: RawResponse = { status: 200, headers: new Headers(), body: { foo: "bar" } };
      expect(strategy.extractCursor(raw)).toBeNull();
      expect(strategy.extractTotal(raw)).toBeNull();
      expect(strategy.hasNext(raw)).toBe(false);
    });

    it("should build the next request using continuation-token", () => {
      const strategy = adapter.paginationStrategy();
      const next = strategy.buildNextRequest("my-bucket", { method: "GET" }, "token_abc");
      expect(next.options.query?.["continuation-token"]).toBe("token_abc");
    });
  });

  describe("getIdempotencyConfig", () => {
    it("should mark GET/HEAD/OPTIONS as safe and PUT as idempotent", () => {
      const config = adapter.getIdempotencyConfig();
      expect(config.defaultSafeOperations.has("GET")).toBe(true);
      expect(config.defaultSafeOperations.has("HEAD")).toBe(true);
      expect(config.operationOverrides?.get("PUT")).toBeDefined();
    });
  });

  describe("verifyWebhook", () => {
    it("should return true for a valid HMAC-SHA256 signature", () => {
      const secret = "webhook_secret";
      const payload = JSON.stringify({ event: "s3:ObjectCreated:Put", bucket: "my-bucket" });
      const signature = createHmac("sha256", secret).update(payload).digest("hex");
      expect(adapter.verifyWebhook(payload, signature, secret)).toBe(true);
    });

    it("should return false for a wrong secret", () => {
      const payload = "raw-body";
      const signature = createHmac("sha256", "real").update(payload).digest("hex");
      expect(adapter.verifyWebhook(payload, signature, "wrong")).toBe(false);
    });

    it("should return false for malformed signatures without throwing", () => {
      expect(adapter.verifyWebhook("payload", "not-hex-and-wrong-length", "secret")).toBe(false);
    });
  });
});
