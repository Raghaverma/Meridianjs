import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { BoundaryGrpcServer } from "./grpc-server.js";

const PROTO_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../../proto/meridian.proto");

const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: Number,
  enums: String,
  defaults: true,
  oneofs: true,
});
const proto = grpc.loadPackageDefinition(packageDefinition) as any;

interface StreamChunkMsg {
  data_json: string;
  index: number;
  event: string;
  raw: string;
  done: boolean;
  error: { message?: string; code?: string; status?: number } | null;
}

function makeClient(port: number) {
  return new proto.meridian.v1.Meridian(`127.0.0.1:${port}`, grpc.credentials.createInsecure());
}

/** Drive StreamCall and collect every chunk (resolves on stream end). */
function streamCall(
  client: any,
  request: Record<string, unknown>,
  metadata?: Record<string, string>,
): Promise<StreamChunkMsg[]> {
  return new Promise((resolveStream, reject) => {
    const md = new grpc.Metadata();
    for (const [k, v] of Object.entries(metadata ?? {})) {
      md.set(k, v);
    }
    const out: StreamChunkMsg[] = [];
    const stream = client.StreamCall(request, md);
    stream.on("data", (chunk: StreamChunkMsg) => out.push(chunk));
    stream.on("end", () => resolveStream(out));
    stream.on("error", reject);
  });
}

/**
 * Mock an upstream SSE response: each entry becomes a `data: <entry>` event,
 * terminated by the SSE `[DONE]` sentinel. A non-2xx status drives the error
 * path (the SDK reads the body and calls adapter.parseError).
 */
function mockSSE(dataEvents: string[], status = 200) {
  const sse = `${dataEvents.map((d) => `data: ${d}\n\n`).join("")}data: [DONE]\n\n`;
  (globalThis as any).fetch = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-type": "text/event-stream" }),
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sse));
        controller.close();
      },
    }),
    json: async () => ({ error: { message: "upstream rejected" } }),
    text: async () => sse,
  });
}

const TEST_CREDENTIALS = {
  github: { token: "ghp_test_token" },
  anthropic: { apiKey: "sk-ant-test" },
  openai: { apiKey: "sk-openai-test" },
};

const PORT = 14742;
const AUTH_PORT = PORT + 100;

let server: BoundaryGrpcServer;
let authServer: BoundaryGrpcServer;
let client: any;
let authClient: any;

beforeAll(async () => {
  mockSSE(["{}"]);
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

describe("BoundaryGrpcServer — StreamCall", () => {
  it("streams token deltas in order, terminated by done=true", async () => {
    mockSSE(['{"delta":"He"}', '{"delta":"llo"}']);
    const chunks = await streamCall(client, {
      provider: "anthropic",
      method: "POST",
      endpoint: "/v1/messages",
      body_json: JSON.stringify({ stream: true }),
    });

    const deltas = chunks.filter((c) => !c.done);
    expect(deltas.map((c) => c.index)).toEqual([0, 1]);
    expect(JSON.parse(deltas[0]?.data_json ?? "{}")).toMatchObject({ delta: "He" });
    expect(JSON.parse(deltas[1]?.data_json ?? "{}")).toMatchObject({ delta: "llo" });

    const terminal = chunks.at(-1);
    expect(terminal?.done).toBe(true);
    expect(terminal?.error?.message ?? "").toBe("");
  });

  it("defaults to POST when no method is given (SSE convention)", async () => {
    mockSSE(['{"delta":"hi"}']);
    await streamCall(client, { provider: "anthropic", endpoint: "/v1/messages" });
    const mockFetch = (globalThis as { fetch: ReturnType<typeof vi.fn> }).fetch;
    const init = mockFetch.mock.calls.at(-1)?.[1] as RequestInit | undefined;
    expect(init?.method?.toUpperCase()).toBe("POST");
  });

  it("rejects StreamCall without a token when auth is required", async () => {
    mockSSE(['{"delta":"hi"}']);
    await expect(
      streamCall(authClient, { provider: "anthropic", method: "POST", endpoint: "/v1/messages" }),
    ).rejects.toMatchObject({ code: grpc.status.UNAUTHENTICATED });
  });

  it("accepts a correct Bearer token and streams", async () => {
    mockSSE(['{"delta":"hi"}']);
    const chunks = await streamCall(
      authClient,
      { provider: "anthropic", method: "POST", endpoint: "/v1/messages" },
      { authorization: "Bearer s3cr3t" },
    );
    expect(chunks.filter((c) => !c.done).length).toBeGreaterThan(0);
    expect(chunks.at(-1)?.done).toBe(true);
  });

  it("emits a single terminal error chunk on an upstream non-2xx", async () => {
    mockSSE([], 401);
    const chunks = await streamCall(client, {
      provider: "anthropic",
      method: "POST",
      endpoint: "/v1/messages",
    });
    const terminal = chunks.at(-1);
    expect(terminal?.done).toBe(true);
    expect(terminal?.error?.message).toBeTruthy();
    // No successful data chunks should precede the error on a failed handshake.
    expect(chunks.filter((c) => !c.done && c.data_json !== "").length).toBe(0);
  });

  it("returns a terminal error chunk for an unknown provider", async () => {
    mockSSE(['{"delta":"hi"}']);
    const chunks = await streamCall(client, {
      provider: "not-a-real-provider",
      method: "POST",
      endpoint: "/v1/messages",
    });
    const terminal = chunks.at(-1);
    expect(terminal?.done).toBe(true);
    expect(terminal?.error?.message ?? "").toMatch(/Unknown provider/);
  });
});
