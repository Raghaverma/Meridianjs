# Meridian — Python

A native Python engine for Meridian's single stable contract across third-party
APIs, plus a gRPC bridge to (and from) the TypeScript engine.

It ports the TypeScript pipeline layer-for-layer — retry, circuit breaking,
token-bucket rate limiting, idempotency classification, request/PII sanitization,
response normalization, and the SSRF endpoint guard — and ships reference
adapters for **GitHub, OpenAI, Anthropic, and Stripe**. The shared contract lives
in [`proto/meridian.proto`](../../proto/meridian.proto); this package implements
and speaks it.

Three ways to use it, one contract:

```
              ┌─────────────────────── proto/meridian.proto ───────────────────────┐
              │            service Meridian { Call, Paginate, Health }              │
              └─────────────────────────────────────────────────────────────────-─┘
 native  ─────────────────────────►  meridian.Meridian            (this package)
 serve   ─────────────────────────►  meridian.grpc_server         (any client can call)
 consume ─────────────────────────►  meridian.grpc_client  ─────► TS or Python engine
```

## Install

```bash
cd clients/python
pip install -e .[dev]
make proto     # generate gRPC stubs from ../../proto/meridian.proto
pytest
```

## Native usage

```python
import asyncio
from meridian import Meridian

async def main():
    meridian = await Meridian.create({
        "providers": {"github": {"auth": {"token": "ghp_..."}}},
    })
    res = await meridian.github.get("/repos/octocat/Hello-World")
    print(res.data["full_name"], res.meta.rate_limit.remaining)

    async for page in meridian.github.paginate("/repos/octocat/Hello-World/issues"):
        print(len(page.data))

asyncio.run(main())
```

Errors surface as a typed `MeridianError` with `.category`, `.code`, `.retryable`,
`.status`, and `.retry_after` — identical semantics to the TypeScript engine.

## Serve the contract over gRPC

```bash
GITHUB_TOKEN=ghp_... MERIDIAN_PROXY_TOKEN=secret meridian-proxy
# or: python -m meridian.grpc_server
```

Any gRPC client can now drive the Python engine via `meridian.v1.Meridian/Call`.

## Consume the contract (drive either engine)

```python
from meridian.grpc_client import MeridianGrpcClient

async with MeridianGrpcClient("127.0.0.1:4242", auth_token="secret") as client:
    res = await client.github.get("/repos/octocat/Hello-World")
    print(res.meta.provider)  # works against the TS server OR the Python server
```

## Layout

| Path | Mirrors (TypeScript) |
| --- | --- |
| `meridian/contract.py` | `src/core/types.ts` |
| `meridian/core/pipeline.py` | `src/core/pipeline.ts` |
| `meridian/core/{normalizer,header_parser,sanitizer,endpoint_validator}.py` | `src/core/*` |
| `meridian/strategies/*` | `src/strategies/*` |
| `meridian/adapter.py` | `ProviderAdapter` in `src/core/types.ts` |
| `meridian/providers/*` | `src/providers/{github,openai,anthropic,stripe}/*` |
| `meridian/client.py` | `src/index.ts` (`Meridian`) |
| `meridian/grpc_server.py` | `src/proxy/grpc-server.ts` |

### Adding more providers

The reference set covers the dominant adapter shapes. To port another provider,
subclass `ProviderAdapter`, implement the seven required methods (plus optional
`verify_webhook` / `capabilities`), and register it in
`meridian/providers/__init__.py::BUILTIN_ADAPTERS`.
