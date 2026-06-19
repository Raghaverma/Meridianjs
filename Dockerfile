# Meridian Boundary Proxy — a Node-free way to run the reliability engine.
#
# The proxy speaks the language-neutral gRPC contract in proto/meridian.proto,
# so any gRPC-capable language (Go, Rust, C, C++, Java, …) can drive the full
# Meridian pipeline — retries, circuit breaking, rate limiting, secret
# redaction, normalization — without installing Node or the npm package.
#
#   docker build -t meridian/proxy .
#   docker run --rm -p 4242:4242 -e GITHUB_TOKEN=... meridian/proxy
#
# The image only ships the compiled engine and the two gRPC runtime deps; it
# never contains your source or dev tooling.

# ---- Stage 1: build the TypeScript engine -----------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app

# Install all deps (incl. dev) against the lockfile for a reproducible build.
COPY package.json package-lock.json ./
RUN npm ci

# Compile src -> dist (tsc). proto/ is needed both to build and at runtime.
# scripts/sync-version.mjs runs via the `prebuild` hook to stamp SDK_VERSION.
COPY tsconfig.json ./
COPY src ./src
COPY proto ./proto
COPY scripts/sync-version.mjs ./scripts/sync-version.mjs
RUN npm run build

# ---- Stage 2: install only the runtime gRPC deps ----------------------------
# @grpc/grpc-js and @grpc/proto-loader are optional peer deps of the SDK; the
# proxy is the one entrypoint that needs them. Installing them in isolation here
# pulls their transitive deps correctly and keeps the final image lean.
FROM node:22-bookworm-slim AS deps
WORKDIR /deps
RUN npm init -y >/dev/null \
 && npm install --omit=dev --no-fund --no-audit \
      @grpc/grpc-js@^1.14.0 \
      @grpc/proto-loader@^0.8.0

# ---- Stage 3: minimal runtime ----------------------------------------------
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Run as the built-in unprivileged user.
USER node

# Compiled engine, the proto contract (resolved at dist/../proto at runtime),
# and the isolated runtime deps.
COPY --chown=node:node --from=build /app/dist ./dist
COPY --chown=node:node --from=build /app/proto ./proto
COPY --chown=node:node --from=deps  /deps/node_modules ./node_modules

# Bind to all interfaces inside the container; publish/firewall at the host.
ENV BOUNDARY_PROXY_HOST=0.0.0.0
ENV BOUNDARY_PROXY_PORT=4242
EXPOSE 4242

# Liveness: the proxy's own unauthenticated Health RPC, driven by a tiny inline
# client so the image needs no extra tooling (grpcurl, etc.).
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD ["node", "dist/proxy/healthcheck.js"]

ENTRYPOINT ["node", "dist/proxy/cli.js"]
