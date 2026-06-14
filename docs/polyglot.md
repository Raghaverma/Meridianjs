# Use Meridian from any language

Meridian's engine is written in TypeScript, but you don't need Node — or even
JavaScript — to use it. The engine runs as a **Boundary Proxy**: a small gRPC
server that applies the full pipeline (retries, circuit breaking, rate limiting,
secret redaction, response normalization across 46 providers) to every request.
Your application talks to it over a language-neutral contract.

```
┌─────────────┐   gRPC    ┌───────────────────────┐   HTTPS   ┌──────────────┐
│  your app   │──────────▶│  Meridian Boundary    │──────────▶│  Stripe,     │
│ (any lang)  │  meridian │  Proxy (the engine)   │  + creds  │  GitHub,     │
│             │◀──────────│  retries · breaker ·  │◀──────────│  OpenAI, …   │
└─────────────┘  .proto   │  rate limit · redact  │           └──────────────┘
                          └───────────────────────┘
```

Why a sidecar instead of a library per language? Because the alternative —
porting 46 adapters and all the resilience logic into C, Rust, Go, Java, … —
means N copies drifting out of sync. With the proxy there is **one engine**.
Add a provider once and every language gets it immediately, with identical
behavior, because they all speak the same contract:
[`proto/meridian.proto`](../proto/meridian.proto).

---

## 1. Run the proxy

### Option A — Docker (recommended, no Node required)

```bash
# from the repo root
cp .env.example .env        # set MERIDIAN_PROXY_TOKEN + the provider creds you use
docker compose up -d        # proxy on 127.0.0.1:4242, with a healthcheck
docker compose ps           # STATUS shows "healthy" once ready
```

Or build and run the image directly:

```bash
docker build -t meridian/proxy .
docker run --rm -p 127.0.0.1:4242:4242 \
  -e MERIDIAN_PROXY_TOKEN="$(openssl rand -hex 32)" \
  -e GITHUB_TOKEN=ghp_... \
  meridian/proxy
```

### Option B — npm (if you already have Node)

```bash
npm install meridianjs
npx boundary-proxy          # the proxy CLI shipped by the package
```

The proxy reads its config from environment variables:

| Variable | Purpose | Default |
| --- | --- | --- |
| `MERIDIAN_PROXY_TOKEN` | Shared secret required on every request. **Required** for any non-loopback bind. | _(none)_ |
| `BOUNDARY_PROXY_PORT` | Port to listen on. | `4242` |
| `BOUNDARY_PROXY_HOST` | Bind address. | `127.0.0.1` |
| `GITHUB_TOKEN`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `STRIPE_SECRET_KEY`, … | Provider credentials, injected upstream by the proxy. | _(none)_ |

---

## 2. Security model

The proxy holds your real provider credentials so your client code never does.
That makes the boundary itself sensitive, so it is locked down by default:

- **Auth token.** When `MERIDIAN_PROXY_TOKEN` is set, every `Call`/`Paginate`
  must present it as gRPC metadata — `authorization: Bearer <token>` or
  `x-proxy-token: <token>`. `Health` is exempt (it returns no secrets).
- **No public bind without a token.** The proxy *refuses to start* on a
  non-loopback host unless a token is set — otherwise anyone who can reach the
  port could spend your credentials. This is why the Docker image requires
  `MERIDIAN_PROXY_TOKEN`.
- **Client headers are stripped.** Inbound `authorization`/`cookie` headers are
  dropped so a caller can't override the injected credential or leak their own.
- **Run it co-located.** Treat the proxy like a database: a sidecar on
  `127.0.0.1` or within a private network. For cross-host traffic, terminate
  TLS in front of it (and still require a token).

---

## 3. Connect from your language

The contract is one gRPC service, `meridian.v1.Meridian`, with three methods:

| RPC | Use |
| --- | --- |
| `Call(CallRequest) → CallResponse` | One normalized request (GET/POST/PUT/PATCH/DELETE). |
| `Paginate(CallRequest) → stream CallResponse` | Traverse a paginated endpoint, one message per page. |
| `Health(HealthRequest) → HealthResponse` | Unauthenticated liveness + provider list. |

Request bodies, normalized response data, and error metadata are carried as
JSON-encoded strings (`body_json`, `data_json`, `metadata_json`) so the wire
format is identical byte-for-byte across languages.

### Smoke test with grpcurl (no codegen)

```bash
grpcurl -plaintext -H 'authorization: Bearer YOUR_TOKEN' \
  -import-path proto -proto meridian.proto \
  -d '{"provider":"github","method":"GET","endpoint":"/repos/octocat/Hello-World"}' \
  127.0.0.1:4242 meridian.v1.Meridian/Call
```

### Generate a client for any language

Point your generator at [`proto/meridian.proto`](../proto/meridian.proto):

| Language | Toolchain |
| --- | --- |
| **Go** | `protoc-gen-go` + `protoc-gen-go-grpc`, or `buf` — see the [reference client](../clients/go) |
| **Rust** | [`tonic-build`](https://github.com/hyperium/tonic) in `build.rs` — see the [reference client](../clients/rust) |
| **C++** | `protoc --grpc_out` with the gRPC C++ plugin |
| **C** | gRPC core + `protoc` (nanopb for embedded) |
| **Java / Kotlin** | `protobuf-gradle-plugin` + `grpc-java` |
| **Python** | committed [reference client](../clients/python), or `grpcio-tools` |
| **C# / .NET** | `Grpc.Tools` NuGet package |

The fastest way to get correct, idiomatic stubs in any of these is
[`buf generate`](https://buf.build) with a plugin block — the Go client's
[`buf.gen.yaml`](../clients/go/buf.gen.yaml) is a copy-paste starting point.

---

## 4. Reference clients: Go & Rust

Two complete, ergonomic, end-to-end-tested clients ship as templates for new
language bindings — thin wrapper, normalized errors, pagination, streaming, TLS:

- **[`clients/go`](../clients/go)** — committed stubs (`go get`, no codegen), plus
  a [black-box conformance suite](../clients/go/conformance) that defines the
  contract every binding must satisfy.
- **[`clients/rust`](../clients/rust)** — tonic + prost, stubs generated at build
  time, mirrors the Go API method-for-method.

```go
// Go
c, _ := meridian.Dial(ctx, "127.0.0.1:4242", meridian.WithToken(token))
resp, err := c.Get(ctx, "github", "/repos/octocat/Hello-World")
```

```rust
// Rust
let c = meridian::Client::connect("127.0.0.1:4242", token).await?;
let resp = c.get("github", "/repos/octocat/Hello-World").await?;
```

When porting to a new language, copy the closest reference client and run the Go
conformance suite against your binding's proxy to confirm parity.

---

## 5. Streaming (AI providers)

Token/SSE streaming is exposed as the server-streaming RPC `StreamCall` — for
Anthropic, OpenAI, Gemini, Cohere, and Mistral. It emits one `StreamChunk` per
upstream SSE delta (carrying the JSON-encoded delta, a 0-based `index`, and the
SSE `event` name), terminated by a final chunk with `done=true`. The request
defaults to `POST`. In Go:

```go
err := c.StreamCall(ctx, meridian.Request{
    Provider: "anthropic",
    Endpoint: "/v1/messages",
    Body:     map[string]any{"model": "claude-opus-4-8", "stream": true, /* … */},
}, func(ch *meridian.Chunk) error {
    var delta map[string]any
    _ = ch.Decode(&delta)
    fmt.Printf("chunk %d: %v\n", ch.Index, delta)
    return nil // return a non-nil error to stop early
})
```

Any language generates the same `StreamCall` stub from the proto. Note: the
proxy applies the same auth, header allowlist, and endpoint-safety guards as
`Call`; backpressure is best-effort in v1.
