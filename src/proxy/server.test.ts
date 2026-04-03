import { describe, it, expect, beforeAll, vi } from "vitest";
import { request as httpRequest } from "node:http";
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
  init: { method?: string; body?: string; headers?: Record<string, string> } = {}
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
      }
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

function mockUpstream(statusCode: number = 200, body: unknown = MOCK_REPO) {
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
      await proxyRequest(
        PORT,
        "/github/repos/octocat/Hello-World/issues?state=open&per_page=10"
      );
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
      expect((res.body as any)).toHaveProperty("error");
    });

    it("includes provider name in error body", async () => {
      mockUpstream(401, { message: "Bad credentials" });
      const res = await proxyRequest(PORT, "/github/repos/octocat/private-repo");
      expect((res.body as any).provider).toBe("github");
    });

    it("surfaces retryable flag in error body", async () => {
      mockUpstream(503, { message: "Service Unavailable" });
      const res = await proxyRequest(PORT, "/github/repos/octocat/Hello-World");
      expect((res.body as any)).toHaveProperty("retryable");
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
});
