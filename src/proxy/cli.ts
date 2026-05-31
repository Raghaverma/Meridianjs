#!/usr/bin/env node

/**
 * Boundary Proxy — CLI entrypoint
 *
 * Starts a local HTTP proxy that routes agent tool calls through the
 * Boundary (Meridian) pipeline: rate limiting, circuit breaking, and
 * secret redaction are applied automatically to every request.
 *
 * Usage:
 *   node dist/proxy/cli.js [port]
 *   BOUNDARY_PROXY_PORT=4242 node dist/proxy/cli.js
 *
 * Environment variables for provider credentials:
 *   GITHUB_TOKEN        — GitHub personal access token
 *   ANTHROPIC_API_KEY   — Anthropic API key
 *   OPENAI_API_KEY      — OpenAI API key
 *   STRIPE_SECRET_KEY   — Stripe secret key
 *
 * Point your Claw agent at:
 *   http://127.0.0.1:<port>/<provider>/<endpoint>
 *
 * Example:
 *   http://127.0.0.1:4242/github/repos/octocat/Hello-World
 *   http://127.0.0.1:4242/anthropic/v1/messages
 */

import { BoundaryProxyServer } from "./server.js";

const portArg = process.env.BOUNDARY_PROXY_PORT ?? process.argv[2];
const port = portArg ? Number.parseInt(portArg, 10) : 4242;

if (Number.isNaN(port) || port < 1 || port > 65535) {
  console.error(`[Boundary Proxy] Invalid port: "${portArg}". Must be 1–65535.`);
  process.exit(1);
}

const server = new BoundaryProxyServer({ port });

server.start().catch((err: unknown) => {
  console.error("[Boundary Proxy] Failed to start:", err);
  process.exit(1);
});
