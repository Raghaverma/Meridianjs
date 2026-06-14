import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { BoundaryGrpcServer } from "./grpc-server.js";

const PROTO_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../../proto/meridian.proto");

// ---------------------------------------------------------------------------
// In-process gRPC client (loads the same proto the server serves).
// ---------------------------------------------------------------------------

const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: Number,
  enums: String,
  defaults: true,
  oneofs: true,
});
const proto = grpc.loadPackageDefinition(packageDefinition) as any;

interface CallResp {
  data_json: string;
  meta: { provider?: string; request_id?: string; rate_limit?: unknown } | null;
  error: { code?: string; provider?: string; retryable?: boolean; status?: number } | null;
}

function makeClient(port: number) {
  return new proto.meridian.v1.Meridian(`127.0.0.1:${port}`, grpc.credentials.createInsecure());
}

function call(
  client: any,
  request: Record<string, unknown>,
  metadata?: Record<string, string>,
): Promise<CallResp> {
  return new Promise((resolveCall, reject) => {
    const md = new grpc.Metadata();
    for (const [k, v] of Object.entries(metadata ?? {})) {
      md.set(k, v);
    }
    client.Call(request, md, (err: grpc.ServiceError | null, response: CallResp) => {
      if (err) reject(err);
      else resolveCall(response);
    });
  });
}

function health(
  client: any,
): Promise<{ status: string; providers: string[]; auth_required: boolean }> {
  return new Promise((resolveHealth, reject) => {
    client.Health({}, (err: grpc.ServiceError | null, response: never) => {
      if (err) reject(err);
      else resolveHealth(response);
    });
  });
}

// ---------------------------------------------------------------------------
// Mock upstream fetch (only intercepts Meridian's outbound calls).
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

const TEST_CREDENTIALS = {
  github: { token: "ghp_test_token" },
  anthropic: { apiKey: "sk-ant-test" },
  openai: { apiKey: "sk-openai-test" },
  stripe: { apiKey: "sk_test_stripe" },
};

const PORT = 14342;
const AUTH_PORT = PORT + 100;

let server: BoundaryGrpcServer;
let authServer: BoundaryGrpcServer;
let client: any;
let authClient: any;

beforeAll(async () => {
  mockUpstream();
  server = new BoundaryGrpcServer({ port: PORT, providers: TEST_CREDENTIALS });
  await server.start();
  client = makeClient(PORT);

  authServer = new BoundaryGrpcServer({
    port: AUTH_PORT,
    providers: TEST_CREDENTIALS,
    authToken: "s3cr3t",
  });
  await authServer.start();
  authClient = makeClient(AUTH_PORT);
});

afterAll(async () => {
  client?.close();
  authClient?.close();
  await server?.stop();
  await authServer?.stop();
});

describe("BoundaryGrpcServer", () => {
  describe("1. Server startup", () => {
    it("defaults to port 4242 when none is provided", () => {
      const s = new BoundaryGrpcServer();
      expect((s as any).port).toBe(4242);
    });

    it("accepts a custom host", () => {
      const s = new BoundaryGrpcServer({ host: "0.0.0.0", port: PORT + 1, authToken: "t" });
      expect((s as any).host).toBe("0.0.0.0");
    });
  });

  describe("2. Health", () => {
    it("reports ok, providers, and auth state without a token", async () => {
      const res = await health(client);
      expect(res.status).toBe("ok");
      expect(res.providers).toContain("github");
      expect(res.auth_required).toBe(false);
    });

    it("stays open even when auth is required", async () => {
      const res = await health(authClient);
      expect(res.status).toBe("ok");
      expect(res.auth_required).toBe(true);
    });
  });

  describe("3. Call routing", () => {
    it("routes a GET and returns a NormalizedResponse shape", async () => {
      mockUpstream(200, MOCK_REPO);
      const res = await call(client, {
        provider: "github",
        method: "GET",
        endpoint: "/repos/octocat/Hello-World",
      });
      expect(res.error).toBeNull();
      expect(res.meta?.provider).toBe("github");
      expect(res.meta?.request_id).toBeTruthy();
      expect(res.meta?.rate_limit).toBeDefined();
      expect(JSON.parse(res.data_json)).toMatchObject({ name: "Hello-World" });
    });

    it("returns an in-band error for an unknown provider", async () => {
      const res = await call(client, {
        provider: "not-a-real-provider",
        method: "GET",
        endpoint: "/x",
      });
      expect(res.error).not.toBeNull();
      expect(res.error?.provider).toBe("not-a-real-provider");
    });

    it("forwards POST with a JSON body", async () => {
      mockUpstream(200, { created: true });
      const res = await call(client, {
        provider: "github",
        method: "POST",
        endpoint: "/user/repos",
        body_json: JSON.stringify({ name: "new-repo" }),
      });
      expect(res.error).toBeNull();
      const mockFetch = (globalThis as any).fetch as ReturnType<typeof vi.fn>;
      const lastCall = mockFetch.mock.calls.at(-1);
      expect(lastCall?.[1]?.method?.toUpperCase()).toBe("POST");
    });

    it("forwards query parameters to the upstream URL", async () => {
      mockUpstream(200, []);
      await call(client, {
        provider: "github",
        method: "GET",
        endpoint: "/repos/octocat/Hello-World/issues",
        query: { state: "open", per_page: "10" },
      });
      const mockFetch = (globalThis as any).fetch as ReturnType<typeof vi.fn>;
      const [calledUrl] = mockFetch.mock.calls.at(-1) ?? [];
      expect(String(calledUrl)).toContain("state=open");
      expect(String(calledUrl)).toContain("per_page=10");
    });
  });

  describe("4. Error mapping", () => {
    it("maps a 404 to a NOT_FOUND error with provider and retryable flag", async () => {
      mockUpstream(404, { message: "Not Found" });
      const res = await call(client, {
        provider: "github",
        method: "GET",
        endpoint: "/repos/octocat/does-not-exist",
      });
      expect(res.error).not.toBeNull();
      expect(res.error?.provider).toBe("github");
      expect(res.error?.status).toBe(404);
      expect(res.error?.code).toBe("NOT_FOUND");
      expect(res.error?.retryable).toBe(false);
    });

    it("marks 5xx upstream failures retryable", async () => {
      mockUpstream(503, { message: "Service Unavailable" });
      const res = await call(client, {
        provider: "github",
        method: "GET",
        endpoint: "/repos/octocat/Hello-World",
      });
      expect(res.error?.code).toBe("UPSTREAM_5XX");
      expect(res.error?.retryable).toBe(true);
    });
  });

  describe("5. Authentication", () => {
    it("rejects a Call without a token", async () => {
      mockUpstream();
      await expect(
        call(authClient, { provider: "github", method: "GET", endpoint: "/x" }),
      ).rejects.toMatchObject({ code: grpc.status.UNAUTHENTICATED });
    });

    it("rejects a Call with the wrong token", async () => {
      mockUpstream();
      await expect(
        call(
          authClient,
          { provider: "github", method: "GET", endpoint: "/x" },
          { authorization: "Bearer wrong" },
        ),
      ).rejects.toMatchObject({ code: grpc.status.UNAUTHENTICATED });
    });

    it("accepts a correct Bearer token", async () => {
      mockUpstream(200, MOCK_REPO);
      const res = await call(
        authClient,
        { provider: "github", method: "GET", endpoint: "/repos/octocat/Hello-World" },
        { authorization: "Bearer s3cr3t" },
      );
      expect(res.error).toBeNull();
    });

    it("accepts a correct x-proxy-token", async () => {
      mockUpstream(200, MOCK_REPO);
      const res = await call(
        authClient,
        { provider: "github", method: "GET", endpoint: "/repos/octocat/Hello-World" },
        { "x-proxy-token": "s3cr3t" },
      );
      expect(res.error).toBeNull();
    });
  });

  describe("6. Header allowlisting", () => {
    it("does not forward client authorization/cookie headers upstream", async () => {
      mockUpstream(200, { ok: true });
      await call(client, {
        provider: "github",
        method: "GET",
        endpoint: "/repos/octocat/Hello-World",
        headers: {
          authorization: "Bearer client-leak",
          cookie: "session=abc",
          "content-type": "application/json",
        },
      });
      const mockFetch = (globalThis as any).fetch as ReturnType<typeof vi.fn>;
      const init = mockFetch.mock.calls.at(-1)?.[1] as RequestInit | undefined;
      const sent = new Headers(init?.headers as HeadersInit);
      expect(sent.get("authorization") ?? "").not.toContain("client-leak");
      expect(sent.has("cookie")).toBe(false);
    });
  });

  describe("7. Non-loopback bind guard", () => {
    it("refuses to start on a non-loopback host without auth", async () => {
      const s = new BoundaryGrpcServer({ host: "0.0.0.0", port: PORT + 200 });
      await expect(s.start()).rejects.toThrow(/non-loopback/i);
    });
  });

  describe("8. All four reference providers are reachable", () => {
    const providers = ["github", "anthropic", "openai", "stripe"] as const;
    for (const provider of providers) {
      it(`routes requests to ${provider}`, async () => {
        mockUpstream(200, { ok: true });
        const res = await call(client, { provider, method: "GET", endpoint: "/v1/test" });
        // Unknown-provider would set error.provider but more importantly a
        // routing miss; a reachable provider returns either data or a mapped
        // upstream error, never an "Unknown provider" message.
        expect(res.error?.message ?? "").not.toMatch(/Unknown provider/);
      });
    }
  });
});
