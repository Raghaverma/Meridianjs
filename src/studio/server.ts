import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Meridian } from "../index.js";
import {
  ContractRegistry,
  DEFAULT_REGISTRY_DIR,
} from "../infrastructure/registry/contract-registry.js";
import { summarizeSession } from "../infrastructure/replay/replayer.js";
import { DEFAULT_RECORDINGS_DIR, ReliabilityStore } from "../infrastructure/replay/store.js";
import { isLoopbackHost, safeEqual } from "../networking/proxy/shared.js";

export interface StudioServerOptions {
  /**
   * Attach a live Meridian instance so health/cost/circuit-breaker/recording
   * endpoints serve real-time data. Omit for a disk-only server — replay
   * sessions and schema-drift history still work; live endpoints return 503.
   */
  meridian?: Meridian;
  /** Port to listen on. Defaults to 4243. */
  port?: number;
  /** Host to bind to. Defaults to 127.0.0.1. */
  host?: string;
  /**
   * Shared secret required on every request via `Authorization: Bearer <token>`.
   * Falls back to the MERIDIAN_STUDIO_TOKEN env var. Strongly recommended for
   * any non-loopback bind — without it, anyone who can reach the port can read
   * live request/cost data and start or stop recordings.
   */
  authToken?: string;
  /** Permit binding to a non-loopback host without an authToken. Off by default. */
  allowUnauthenticatedRemote?: boolean;
  /** Origin allowed to call this API (the dashboard's URL). Defaults to http://localhost:3000. */
  allowedOrigin?: string;
  /** Directory holding contract-registry snapshots. Defaults to .meridian/registry. */
  registryDir?: string;
  /** Directory holding reliability recordings. Defaults to .meridian/recordings. */
  recordingsDir?: string;
}

export interface StudioServerHandle {
  readonly url: string;
  close(): Promise<void>;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function liveUnavailable() {
  return {
    error:
      "This Studio server is running standalone (no live Meridian instance attached). " +
      "Call `await meridian.studio({ ... })` from your app to enable live endpoints.",
  };
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  return JSON.parse(raw) as Record<string, unknown>;
}

/** Starts the Meridian Studio HTTP API — see docs/studio.md for the full route list. */
export async function createStudioServer(
  opts: StudioServerOptions = {},
): Promise<StudioServerHandle> {
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 4243;
  const authToken = opts.authToken ?? process.env.MERIDIAN_STUDIO_TOKEN ?? undefined;
  const allowedOrigin = opts.allowedOrigin ?? "http://localhost:3000";
  const registry = new ContractRegistry(opts.registryDir ?? DEFAULT_REGISTRY_DIR);
  const store = new ReliabilityStore(opts.recordingsDir ?? DEFAULT_RECORDINGS_DIR);
  const meridian = opts.meridian;

  if (!isLoopbackHost(host) && !authToken && !opts.allowUnauthenticatedRemote) {
    throw new Error(
      `[Meridian Studio] Refusing to bind to non-loopback host "${host}" without an authToken. ` +
        "Anyone who can reach this port could read live request/cost data and control recording. " +
        "Set `authToken` (or MERIDIAN_STUDIO_TOKEN), bind to 127.0.0.1, or pass " +
        "`allowUnauthenticatedRemote: true` to override.",
    );
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (authToken) {
      const header = req.headers.authorization ?? "";
      const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
      if (!safeEqual(presented, authToken)) {
        send(res, 401, { error: "Unauthorized" });
        return;
      }
    }

    const url = new URL(req.url ?? "/", `http://${host}:${port}`);
    const segments = url.pathname.split("/").filter(Boolean);

    if (segments[0] !== "api") {
      send(res, 404, { error: "Not found" });
      return;
    }

    if (segments.length === 2 && segments[1] === "health" && req.method === "GET") {
      if (!meridian) return send(res, 503, liveUnavailable());
      return send(res, 200, meridian.health());
    }

    if (segments.length === 2 && segments[1] === "providers" && req.method === "GET") {
      if (!meridian) return send(res, 503, liveUnavailable());
      return send(res, 200, meridian.providers());
    }

    if (segments.length === 2 && segments[1] === "circuit-breakers" && req.method === "GET") {
      if (!meridian) return send(res, 503, liveUnavailable());
      const out: Record<string, unknown> = {};
      for (const p of meridian.providers()) {
        out[p.name] = meridian.getCircuitStatus(p.name);
      }
      return send(res, 200, out);
    }

    if (segments.length === 2 && segments[1] === "cost" && req.method === "GET") {
      if (!meridian) return send(res, 503, liveUnavailable());
      return send(res, 200, meridian.cost(url.searchParams.get("currency") ?? "USD"));
    }

    if (
      segments.length === 3 &&
      segments[1] === "recording" &&
      segments[2] === "status" &&
      req.method === "GET"
    ) {
      if (!meridian) return send(res, 503, liveUnavailable());
      return send(res, 200, meridian.recordingStatus());
    }

    if (
      segments.length === 3 &&
      segments[1] === "recording" &&
      segments[2] === "start" &&
      req.method === "POST"
    ) {
      if (!meridian) return send(res, 503, liveUnavailable());
      const body = await readJsonBody(req);
      const sessionName = meridian.startRecording(
        typeof body.name === "string" ? body.name : undefined,
      );
      return send(res, 200, { sessionName });
    }

    if (
      segments.length === 3 &&
      segments[1] === "recording" &&
      segments[2] === "stop" &&
      req.method === "POST"
    ) {
      if (!meridian) return send(res, 503, liveUnavailable());
      const body = await readJsonBody(req);
      const stopOpts: { dir?: string; save?: boolean } = {};
      if (typeof body.save === "boolean") stopOpts.save = body.save;
      if (typeof body.dir === "string") stopOpts.dir = body.dir;
      const session = await meridian.stopRecording(stopOpts);
      return send(res, 200, summarizeSession(session));
    }

    if (
      segments.length === 3 &&
      segments[1] === "replay" &&
      segments[2] === "sessions" &&
      req.method === "GET"
    ) {
      return send(res, 200, { sessions: await store.list() });
    }

    if (
      segments.length === 4 &&
      segments[1] === "replay" &&
      segments[2] === "sessions" &&
      req.method === "GET"
    ) {
      const name = decodeURIComponent(segments[3]!);
      const session = await store.load(name);
      return send(res, 200, summarizeSession(session));
    }

    if (
      segments.length === 3 &&
      segments[1] === "registry" &&
      segments[2] === "providers" &&
      req.method === "GET"
    ) {
      return send(res, 200, { providers: await registry.listProviders() });
    }

    if (segments.length === 3 && segments[1] === "registry" && req.method === "GET") {
      const provider = decodeURIComponent(segments[2]!);
      const endpoint = url.searchParams.get("endpoint");
      if (endpoint !== null) {
        return send(res, 200, { history: await registry.history(provider, endpoint) });
      }
      return send(res, 200, await registry.report(provider));
    }

    send(res, 404, { error: "Not found" });
  }

  const server = createServer((req, res) => {
    route(req, res).catch((err: unknown) => {
      if (!res.headersSent) {
        send(res, 500, { error: err instanceof Error ? err.message : "Internal error" });
      }
    });
  });

  const boundPort = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const address = server.address();
      resolve(typeof address === "object" && address !== null ? address.port : port);
    });
  });

  return {
    url: `http://${host}:${boundPort}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
