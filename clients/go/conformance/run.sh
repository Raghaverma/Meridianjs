#!/usr/bin/env bash
# Run the Meridian conformance suite end-to-end: start a token-protected proxy
# in Docker (no provider credentials needed), run the Go contract tests against
# it on a shared network, then tear everything down.
#
#   ./run.sh                 # builds the proxy image if missing, runs conformance
#   PROXY_IMAGE=meridian/proxy:latest ./run.sh
#
# Requires Docker. Exits non-zero if any contract invariant fails.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PROXY_IMAGE="${PROXY_IMAGE:-meridian/proxy:conformance}"
NET="meridian-conformance-net"
PROXY="meridian-conformance-proxy"
TOKEN="conformance-$$-token"

cleanup() {
  docker rm -f "$PROXY" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Build the proxy image if it isn't present.
if ! docker image inspect "$PROXY_IMAGE" >/dev/null 2>&1; then
  echo "Building proxy image $PROXY_IMAGE ..."
  docker build -t "$PROXY_IMAGE" "$REPO_ROOT"
fi

docker network create "$NET" >/dev/null 2>&1 || true
echo "Starting proxy (token-protected, no provider creds) ..."
docker run -d --name "$PROXY" --network "$NET" \
  -e MERIDIAN_PROXY_TOKEN="$TOKEN" "$PROXY_IMAGE" >/dev/null

# Wait for the proxy to answer its own Health probe.
for _ in $(seq 1 30); do
  if docker exec "$PROXY" node dist/proxy/healthcheck.js >/dev/null 2>&1; then break; fi
  sleep 1
done

echo "Running conformance suite ..."
docker run --rm --network "$NET" \
  -v "$REPO_ROOT/clients/go":/src -w /src \
  -e MERIDIAN_PROXY_ADDR="$PROXY:4242" \
  -e MERIDIAN_PROXY_TOKEN="$TOKEN" \
  golang:1.22 go test ./conformance -v
