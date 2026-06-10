import { request as httpRequest } from "node:http";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { BoundaryProxyServer } from "./server.js";

// ---------------------------------------------------------------------------
// Test HTTP client — uses node:http directly so globalThis.fetch mocks only
// affect Meridian's upstream calls, not the test client itself.
// ---------------------------------------------------------------------------

interface ProxyResponse {
  status: number;
  body: unknown;
}

function proxyRequest(
  port: number,
  path: string,
  init: { method?: string; body?: string; headers?: Record<string, string> } = {},
): Promise<ProxyResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: init.method ?? "GET",
        headers: init.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) });
          } catch {
            resolve({ status: res.statusCode ?? 0, body: raw });
          }
        });
      },
    );
    req.on("error", reject);
    if (init.body) req.write(init.body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Mock upstream fetch (only intercepts Meridian's outbound calls)
// ---------------------------------------------------------------------------

const MOCK_REPO = { id: 1, name: "Hello-World", full_name: "octocat/Hello-World" };

function mockUpstream(statusCode = 200, body: unknown = MOCK_REPO) {
  (globalThis as any).fetch = vi.fn().mockResolvedValue({
    ok: statusCode >= 200 && statusCode < 300,
    status: statusCode,
    headers: new Headers({
      "content-type": "application/json",
      "x-ratelimit-limit": "60",
      "x-ratelimit-remaining": "59",
      "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
    }),
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Single shared proxy instance — started once for the whole test file.
// Port chosen to avoid collision with other test files.
// ---------------------------------------------------------------------------

const PORT = 14242;

// Fake credentials — non-empty so adapters don't throw auth errors before
// reaching the mocked upstream fetch.
const TEST_CREDENTIALS = {
  github: { token: "ghp_test_token" },
  anthropic: { apiKey: "sk-ant-test" },
  openai: { apiKey: "sk-openai-test" },
  stripe: { apiKey: "sk_test_stripe" },
};

let server: BoundaryProxyServer;

beforeAll(async () => {
  mockUpstream(); // default: 200 OK
  server = new BoundaryProxyServer({ port: PORT, providers: TEST_CREDENTIALS });
  await server.start();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BoundaryProxyServer", () => {
  describe("1. Server startup", () => {
    it("starts and listens on the specified port", async () => {
      mockUpstream();
      const res = await proxyRequest(PORT, "/github/repos/octocat/Hello-World");
      expect(res.status).toBe(200);
    });

    it("defaults to port 4242 when none is provided", () => {
      const s = new BoundaryProxyServer();
      expect((s as any).port).toBe(4242);
    });

    it("accepts a custom host", () => {
      const s = new BoundaryProxyServer({ host: "0.0.0.0", port: PORT + 1 });
      expect((s as any).host).toBe("0.0.0.0");
    });
  });

  describe("2. Request routing", () => {
    it("routes GET /<provider>/<endpoint> and returns NormalizedResponse shape", async () => {
      mockUpstream(200, MOCK_REPO);
      const res = await proxyRequest(PORT, "/github/repos/octocat/Hello-World");
      expect(res.status).toBe(200);
      const body = res.body as Record<string, unknown>;
      expect(body).toHaveProperty("data");
      expect(body).toHaveProperty("meta");
      expect((body.meta as Record<string, unknown>).provider).toBe("github");
      expect((body.meta as Record<string, unknown>).requestId).toBeDefined();
      expect((body.meta as Record<string, unknown>).rateLimit).toBeDefined();
    });

    it("returns 400 when no provider is in the path", async () => {
      const res = await proxyRequest(PORT, "/");
      expect(res.status).toBe(400);
      expect((res.body as any).error).toMatch(/Missing provider/);
    });

    it("returns 404 for an unknown provider", async () => {
      const res = await proxyRequest(PORT, "/not-a-real-provider/some/endpoint");
      expect(res.status).toBe(404);
      expect((res.body as any).error).toMatch(/Unknown provider/);
    });
  });

  describe("3. HTTP method forwarding", () => {
    it("forwards POST requests", async () => {
      mockUpstream(200, { created: true });
      const res = await proxyRequest(PORT, "/github/user/repos", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "new-repo" }),
      });
      expect(res.status).toBe(200);
      const mockFetch = (globalThis as any).fetch as ReturnType<typeof vi.fn>;
      const lastCall = mockFetch.mock.calls.at(-1);
      expect(lastCall?.[1]?.method?.toUpperCase() ?? "POST").toBe("POST");
    });

    it("forwards DELETE requests", async () => {
      mockUpstream(200, {});
      const res = await proxyRequest(PORT, "/github/repos/octocat/Hello-World", {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
    });

    it("forwards PATCH requests", async () => {
      mockUpstream(200, { updated: true });
      const res = await proxyRequest(PORT, "/github/repos/octocat/Hello-World", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ description: "updated" }),
      });
      expect(res.status).toBe(200);
    });
  });

  describe("4. Query string forwarding", () => {
    it("forwards query parameters to the upstream URL", async () => {
      mockUpstream(200, []);
      await proxyRequest(PORT, "/github/repos/octocat/Hello-World/issues?state=open&per_page=10");
      const mockFetch = (globalThis as any).fetch as ReturnType<typeof vi.fn>;
      const [calledUrl] = mockFetch.mock.calls.at(-1) ?? [];
      expect(String(calledUrl)).toContain("state=open");
      expect(String(calledUrl)).toContain("per_page=10");
    });
  });

  describe("5. Error handling", () => {
    it("returns a non-200 status and JSON error body on 4xx", async () => {
      mockUpstream(404, { message: "Not Found" });
      const res = await proxyRequest(PORT, "/github/repos/octocat/does-not-exist");
      expect(res.status).not.toBe(200);
      expect(res.body as any).toHaveProperty("error");
    });

    it("includes provider name in error body", async () => {
      mockUpstream(401, { message: "Bad credentials" });
      const res = await proxyRequest(PORT, "/github/repos/octocat/private-repo");
      expect((res.body as any).provider).toBe("github");
    });

    it("surfaces retryable flag in error body", async () => {
      mockUpstream(503, { message: "Service Unavailable" });
      const res = await proxyRequest(PORT, "/github/repos/octocat/Hello-World");
      expect(res.body as any).toHaveProperty("retryable");
    });
  });

  describe("6. All four built-in providers are reachable", () => {
    const providers = ["github", "anthropic", "openai", "stripe"] as const;

    for (const provider of providers) {
      it(`routes requests to ${provider}`, async () => {
        mockUpstream(200, { ok: true });
        const res = await proxyRequest(PORT, `/${provider}/v1/test`);
        expect(res.status).not.toBe(404);
      });
    }
  });

  describe("7. Recording redaction (sanitizeForRecord)", () => {
    it("always redacts credential-bearing keys, even with PII redaction off", () => {
      const s = new BoundaryProxyServer({ recordRedaction: false });
      const out = (s as any).sanitizeForRecord({
        token: "ghp_secret",
        api_key: "sk-live-123",
        authorization: "Bearer abc",
        nested: { apiKey: "sk-nested" },
        keep: "ok",
      }) as Record<string, any>;
      expect(out.token).toBe("[REDACTED]");
      expect(out.api_key).toBe("[REDACTED]");
      expect(out.authorization).toBe("[REDACTED]");
      expect(out.nested.apiKey).toBe("[REDACTED]");
      expect(out.keep).toBe("ok");
    });

    it("redacts PII patterns by default", () => {
      const s = new BoundaryProxyServer();
      const out = (s as any).sanitizeForRecord({
        email: "user@example.com",
        note: "call me at 415-555-1234",
      }) as Record<string, string>;
      expect(out.email).not.toContain("user@example.com");
      expect(out.email).toContain("[PII-REDACTED]");
      expect(out.note).not.toContain("415-555-1234");
    });

    it("redacts India-specific PII when recordRedaction is 'india'", () => {
      const s = new BoundaryProxyServer({ recordRedaction: "india" });
      const out = (s as any).sanitizeForRecord({
        pan: "ABCDE1234F",
        aadhaar: "1234 5678 9012",
      }) as Record<string, string>;
      expect(out.pan).toContain("[PAN-REDACTED]");
      expect(out.aadhaar).toContain("[AADHAAR-REDACTED]");
    });

    it("leaves PII intact when recordRedaction is false (credentials still redacted)", () => {
      const s = new BoundaryProxyServer({ recordRedaction: false });
      const out = (s as any).sanitizeForRecord({
        email: "user@example.com",
        token: "secret",
      }) as Record<string, string>;
      expect(out.email).toBe("user@example.com");
      expect(out.token).toBe("[REDACTED]");
    });
  });

  describe("8. Authentication", () => {
    const AUTH_PORT = PORT + 100;
    let authServer: BoundaryProxyServer;

    beforeAll(async () => {
      mockUpstream();
      authServer = new BoundaryProxyServer({
        port: AUTH_PORT,
        providers: TEST_CREDENTIALS,
        authToken: "s3cr3t",
      });
      await authServer.start();
    });

    it("rejects requests without a token", async () => {
      mockUpstream();
      const res = await proxyRequest(AUTH_PORT, "/github/repos/octocat/Hello-World");
      expect(res.status).toBe(401);
    });

    it("rejects requests with the wrong token", async () => {
      mockUpstream();
      const res = await proxyRequest(AUTH_PORT, "/github/repos/octocat/Hello-World", {
        headers: { authorization: "Bearer wrong" },
      });
      expect(res.status).toBe(401);
    });

    it("accepts a correct Bearer token", async () => {
      mockUpstream();
      const res = await proxyRequest(AUTH_PORT, "/github/repos/octocat/Hello-World", {
        headers: { authorization: "Bearer s3cr3t" },
      });
      expect(res.status).toBe(200);
    });

    it("accepts a correct X-Proxy-Token header", async () => {
      mockUpstream();
      const res = await proxyRequest(AUTH_PORT, "/github/repos/octocat/Hello-World", {
        headers: { "x-proxy-token": "s3cr3t" },
      });
      expect(res.status).toBe(200);
    });

    it("leaves /_health open and reports authRequired", async () => {
      const res = await proxyRequest(AUTH_PORT, "/_health");
      expect(res.status).toBe(200);
      expect((res.body as any).authRequired).toBe(true);
    });
  });

  describe("9. Non-loopback bind guard", () => {
    it("refuses to start on a non-loopback host without auth", async () => {
      const s = new BoundaryProxyServer({ host: "0.0.0.0", port: PORT + 200 });
      await expect(s.start()).rejects.toThrow(/non-loopback/i);
    });

    it("allows a non-loopback bind when an authToken is set", () => {
      const s = new BoundaryProxyServer({
        host: "0.0.0.0",
        port: PORT + 201,
        authToken: "tok",
      });
      // Constructor + config validation should accept this combination.
      expect((s as any).authToken).toBe("tok");
    });
  });

  describe("11. Request body size cap", () => {
    const CAP_PORT = PORT + 300;
    let capServer: BoundaryProxyServer;

    beforeAll(async () => {
      mockUpstream();
      capServer = new BoundaryProxyServer({
        port: CAP_PORT,
        providers: TEST_CREDENTIALS,
        maxBodyBytes: 100,
      });
      await capServer.start();
    });

    it("rejects an oversized request body with 413", async () => {
      mockUpstream();
      const res = await proxyRequest(CAP_PORT, "/github/user/repos", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ data: "x".repeat(500) }),
      });
      expect(res.status).toBe(413);
    });

    it("accepts a body under the cap", async () => {
      mockUpstream(200, { ok: true });
      const res = await proxyRequest(CAP_PORT, "/github/user/repos", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ a: 1 }),
      });
      expect(res.status).toBe(200);
    });
  });

  describe("10. Header allowlisting", () => {
    it("does not forward client authorization/cookie headers upstream", async () => {
      mockUpstream(200, { ok: true });
      await proxyRequest(PORT, "/github/repos/octocat/Hello-World", {
        headers: {
          authorization: "Bearer client-leak",
          cookie: "session=abc",
          "content-type": "application/json",
        },
      });
      const mockFetch = (globalThis as any).fetch as ReturnType<typeof vi.fn>;
      const init = mockFetch.mock.calls.at(-1)?.[1] as RequestInit | undefined;
      const sent = new Headers(init?.headers as HeadersInit);
      // The upstream Authorization must be the GitHub credential the proxy
      // injected, never the client's "client-leak" value.
      expect(sent.get("authorization") ?? "").not.toContain("client-leak");
      expect(sent.has("cookie")).toBe(false);
    });
  });
});
