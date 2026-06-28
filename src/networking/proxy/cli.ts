#!/usr/bin/env node

/**
 * Boundary Proxy — CLI entrypoint
 *
 * Starts a local gRPC server that routes calls through the Boundary (Meridian)
 * pipeline: rate limiting, circuit breaking, and secret redaction are applied
 * automatically to every request. Any gRPC-capable language can drive it via
 * the `meridian.v1.Meridian` service defined in proto/meridian.proto.
 *
 * Usage:
 *   node dist/proxy/cli.js [port]
 *   BOUNDARY_PROXY_PORT=4242 node dist/proxy/cli.js
 *
 * Server configuration (environment variables):
 *   BOUNDARY_PROXY_PORT — port to listen on (default 4242)
 *   BOUNDARY_PROXY_HOST — host to bind (default 127.0.0.1)
 *   MERIDIAN_PROXY_TOKEN — shared secret required on every request (metadata)
 *
 * Environment variables for provider credentials:
 *   GITHUB_TOKEN        — GitHub personal access token
 *   ANTHROPIC_API_KEY   — Anthropic API key
 *   OPENAI_API_KEY      — OpenAI API key
 *   STRIPE_SECRET_KEY   — Stripe secret key
 *
 * Call the service at:
 *   <host>:<port>  meridian.v1.Meridian/Call
 *
 * Example (grpcurl):
 *   grpcurl -plaintext -d '{"provider":"github","method":"GET",
 *     "endpoint":"/repos/octocat/Hello-World"}' \
 *     127.0.0.1:4242 meridian.v1.Meridian/Call
 */

import { BoundaryGrpcServer } from "./grpc-server.js";

const portArg = process.env.BOUNDARY_PROXY_PORT ?? process.argv[2];
const port = portArg ? Number.parseInt(portArg, 10) : 4242;

if (Number.isNaN(port) || port < 1 || port > 65535) {
  console.error(`[Boundary Proxy] Invalid port: "${portArg}". Must be 1–65535.`);
  process.exit(1);
}

const serverOpts: ConstructorParameters<typeof BoundaryGrpcServer>[0] = { port };
const host = process.env.BOUNDARY_PROXY_HOST;
if (host) serverOpts.host = host;
const authToken = process.env.MERIDIAN_PROXY_TOKEN;
if (authToken) serverOpts.authToken = authToken;

const server = new BoundaryGrpcServer(serverOpts);

server.start().catch((err: unknown) => {
  console.error("[Boundary Proxy] Failed to start:", err);
  process.exit(1);
});
