# Meridian — Python client

A thin gRPC client for the Meridian engine — the recommended way to use Meridian from Python. Point it at the Docker proxy and get all 46 providers, retries, circuit breaking, rate limiting, and normalized errors with no Python reimplementation required.

```bash
pip install meridian          # grpcio + protobuf only — no httpx required
make proto                    # generate stubs once from ../../proto/meridian.proto
```

Start the engine (no Node required):

```bash
cp ../../.env.example ../../.env   # set MERIDIAN_PROXY_TOKEN + provider creds
docker compose -f ../../docker-compose.yml up -d
```

## Usage

```python
from meridian.grpc_client import MeridianGrpcClient

async with MeridianGrpcClient("127.0.0.1:4242", auth_token="secret") as client:
    # Regular call
    res = await client.github.get("/repos/octocat/Hello-World")
    print(res.data["full_name"], res.meta.rate_limit.remaining)

    # Streaming (LLM token deltas — Anthropic, OpenAI, Gemini, Cohere, …)
    async for chunk in client.anthropic.stream_call("/v1/messages", body={...}):
        print(chunk.data, end="", flush=True)

    # Pagination
    async for page in client.github.paginate("/repos/octocat/Hello-World/issues"):
        print(len(page.data), "issues")
```

All errors surface as `MeridianError` with `.category`, `.code`, `.retryable`, and `.retry_after` — identical to the TypeScript and Go clients.

## TLS

```python
client = MeridianGrpcClient("your-host:443", auth_token="secret", tls=True)
```

## Chunk type

`stream_call` yields `Chunk` objects:

```python
from meridian import Chunk

chunk.data    # decoded JSON delta (dict or None on terminal chunk)
chunk.index   # 0-based position in the stream
chunk.event   # SSE event name (empty string when absent)
chunk.raw     # verbatim SSE data payload
```

## Parity

This client matches the Go and Rust clients feature-for-feature:

| Feature | Python | Go | Rust |
|---|---|---|---|
| `call` / HTTP verbs | ✅ | ✅ | ✅ |
| `stream_call` | ✅ | ✅ | ✅ |
| `paginate` | ✅ | ✅ | ✅ |
| `health` | ✅ | ✅ | ✅ |
| TLS | ✅ | ✅ | ✅ |
| Auth token | ✅ | ✅ | ✅ |

## Native engine (secondary path)

A native Python reimplementation of the pipeline ships in this package with adapters for GitHub, OpenAI, Anthropic, and Stripe. Install with the `native` extra:

```bash
pip install "meridian[native]"   # adds httpx
```

```python
from meridian import Meridian

meridian = await Meridian.create({
    "providers": {"github": {"auth": {"token": "ghp_..."}}},
})
res = await meridian.github.get("/repos/octocat/Hello-World")
```

The native engine covers 4 providers; the gRPC client covers all 47.

## Layout

| Path | Purpose |
|---|---|
| `meridian/grpc_client.py` | Thin gRPC client (recommended) |
| `meridian/contract.py` | Shared types — mirrors `src/core/types.ts` |
| `meridian/grpc_server.py` | Serve the Python engine over gRPC |
| `meridian/client.py` | Native Python engine |
| `meridian/providers/` | 4 native adapters (github, openai, anthropic, stripe) |
