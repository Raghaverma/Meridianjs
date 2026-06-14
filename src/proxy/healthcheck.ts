#!/usr/bin/env node

/**
 * Boundary Proxy — container liveness probe.
 *
 * Connects to the locally running proxy and calls the unauthenticated Health
 * RPC. Exits 0 when the server answers (status "ok"/"serving"), non-zero
 * otherwise. Used by the Dockerfile HEALTHCHECK so the image needs no extra
 * tooling such as grpcurl. Honours the same env vars as the server:
 *
 *   BOUNDARY_PROXY_PORT (default 4242)
 *   BOUNDARY_PROXY_HOST (default 127.0.0.1 — probe always dials loopback)
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";

const PROTO_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../../proto/meridian.proto");

const port = Number.parseInt(process.env.BOUNDARY_PROXY_PORT ?? "4242", 10);
// Always dial loopback for the probe: the server binds 0.0.0.0 in-container but
// is reachable on 127.0.0.1 from inside the same container.
const target = `127.0.0.1:${Number.isNaN(port) ? 4242 : port}`;

const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: Number,
  enums: String,
  defaults: true,
  oneofs: true,
});
const proto = grpc.loadPackageDefinition(packageDefinition) as unknown as {
  meridian: {
    v1: {
      Meridian: new (
        address: string,
        creds: grpc.ChannelCredentials,
      ) => grpc.Client & {
        Health: (
          req: Record<string, never>,
          cb: (err: grpc.ServiceError | null, res?: { status?: string }) => void,
        ) => void;
      };
    };
  };
};

const client = new proto.meridian.v1.Meridian(target, grpc.credentials.createInsecure());

const deadline = new Date(Date.now() + 4000);
client.waitForReady(deadline, (readyErr) => {
  if (readyErr) {
    console.error(`[healthcheck] cannot reach proxy at ${target}: ${readyErr.message}`);
    process.exit(1);
  }
  client.Health({}, (err, res) => {
    client.close();
    if (err) {
      console.error(`[healthcheck] Health RPC failed: ${err.message}`);
      process.exit(1);
    }
    const status = (res?.status ?? "").toLowerCase();
    if (status === "ok" || status === "serving" || status === "healthy") {
      process.exit(0);
    }
    console.error(`[healthcheck] unexpected status: ${JSON.stringify(res?.status)}`);
    process.exit(1);
  });
});
