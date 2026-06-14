# Meridian — Go client

The Go binding for [Meridian](../../README.md). It is a thin gRPC client over
the Boundary Proxy: the reliability engine (retries, circuit breaking, rate
limiting, secret redaction, response normalization across 46 providers) runs in
the proxy, and this package gives Go one stable, typed interface to all of it.
No provider logic is reimplemented in Go — add a provider to the engine once and
every language, including this one, gets it for free.

```
your Go app ──gRPC──▶ Meridian Boundary Proxy ──▶ Stripe / GitHub / OpenAI / …
              (this package)        (the engine)
```

## Install

```bash
go get github.com/Raghaverma/meridianjs/clients/go/meridian
```

The generated gRPC stubs are committed under [`genproto/`](genproto), so this
builds with no `protoc`/`buf` on your machine.

## Run the proxy

The client needs a proxy to talk to. From the repo root:

```bash
cp .env.example .env          # set MERIDIAN_PROXY_TOKEN + provider creds
docker compose up -d          # proxy on 127.0.0.1:4242
```

See [docs/polyglot.md](../../docs/polyglot.md) for other ways to run it.

## Use

```go
ctx := context.Background()

c, err := meridian.Dial(ctx, "127.0.0.1:4242",
    meridian.WithToken(os.Getenv("MERIDIAN_PROXY_TOKEN")))
if err != nil {
    log.Fatal(err)
}
defer c.Close()

// GET — same call shape for any of the 46 providers.
resp, err := c.Get(ctx, "github", "/repos/octocat/Hello-World")
if err != nil {
    log.Fatal(err)
}

var repo struct {
    FullName string `json:"full_name"`
    Stars    int    `json:"stargazers_count"`
}
_ = resp.Decode(&repo)
fmt.Println(repo.FullName, repo.Stars)

// POST with a JSON body.
charge, err := c.Post(ctx, "stripe", "/v1/charges", map[string]any{
    "amount":   2000,
    "currency": "usd",
}, meridian.WithIdempotencyKey("order-4242"))
```

### Normalized errors

Failures are the same shape for every provider, so you branch on classification,
not provider-specific JSON:

```go
resp, err := c.Get(ctx, "stripe", "/v1/charges/missing")
var me *meridian.Error
if errors.As(err, &me) {
    fmt.Println(me.GetCategory(), me.GetStatus(), me.Retryable())
}
```

### Pagination

```go
err := c.Paginate(ctx, meridian.Request{
    Provider: "github",
    Endpoint: "/user/repos",
}, func(page *meridian.Response) error {
    var repos []map[string]any
    _ = page.Decode(&repos)
    fmt.Printf("page of %d repos\n", len(repos))
    return nil // return a non-nil error to stop early
})
```

### Streaming (AI providers)

`StreamCall` streams an SSE/token response, one `Chunk` per delta, ending on a
terminal `done` chunk. Defaults to `POST`.

```go
err := c.StreamCall(ctx, meridian.Request{
    Provider: "anthropic",
    Endpoint: "/v1/messages",
    Body:     map[string]any{"model": "claude-opus-4-8", "stream": true},
}, func(ch *meridian.Chunk) error {
    var delta map[string]any
    _ = ch.Decode(&delta)
    fmt.Printf("chunk %d: %v\n", ch.Index, delta)
    return nil
})
```

### Health / capabilities

```go
h, _ := c.Health(ctx) // unauthenticated
fmt.Println(h.GetStatus(), h.GetProviders())
```

## Example

A complete runnable program is in [`example/`](example):

```bash
docker compose up -d                       # from repo root
cd clients/go
MERIDIAN_PROXY_TOKEN=... go run ./example
```

## Conformance suite

[`conformance/`](conformance) is a black-box contract test that asserts the
proxy's guarantees at the gRPC layer — auth enforcement, the SSRF endpoint
guard, normalized errors — against a running proxy. It needs no provider
credentials. Run it end-to-end (starts a token-protected proxy in Docker):

```bash
make conformance        # or: ./conformance/run.sh
```

It's the same contract any language binding must satisfy, so it doubles as the
reference for porting Meridian to a new language.

## Regenerating stubs

Only needed after editing [`proto/meridian.proto`](../../proto/meridian.proto):

```bash
make generate   # runs buf in Docker, then `go mod tidy`
```

## TLS / remote proxy

`Dial` defaults to plaintext for a co-located loopback proxy. For a remote
proxy, dial over TLS and always send a token:

```go
c, err := meridian.Dial(ctx, "proxy.internal:4242",
    meridian.WithTLS(nil), // platform default client config
    meridian.WithToken(token))
```
