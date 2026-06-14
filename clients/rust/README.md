# Meridian — Rust client

The Rust binding for [Meridian](../../README.md). A thin async (tonic) client
over the Boundary Proxy: the reliability engine (retries, circuit breaking, rate
limiting, secret redaction, normalization across 46 providers) runs in the
proxy, and this crate gives Rust one stable, typed interface to all of it. No
provider logic is reimplemented here.

```
your Rust app ──gRPC──▶ Meridian Boundary Proxy ──▶ Stripe / GitHub / OpenAI / …
              (this crate)         (the engine)
```

## Requirements

- A running proxy (see the repo's [`docker-compose.yml`](../../docker-compose.yml)).
- `protoc` on `PATH` at build time — the stubs are generated from
  [`proto/meridian.proto`](../../proto/meridian.proto) by `build.rs`:
  - macOS: `brew install protobuf`
  - Debian/Ubuntu: `apt-get install -y protobuf-compiler`

## Use

```rust
use meridian::Client;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let token = std::env::var("MERIDIAN_PROXY_TOKEN").ok();
    let client = Client::connect("127.0.0.1:4242", token).await?;

    // GET — same call shape for any of the 46 providers.
    let repo = client.get("github", "/repos/octocat/Hello-World").await?;
    println!("{}", repo.data["full_name"]);

    // POST with a JSON body.
    let charge = client
        .post("stripe", "/v1/charges", &serde_json::json!({ "amount": 2000, "currency": "usd" }))
        .await?;
    println!("{:?}", charge.meta.map(|m| m.request_id));

    Ok(())
}
```

### Normalized errors

Failures are the same shape for every provider — branch on classification, not
provider-specific JSON:

```rust
match client.get("stripe", "/v1/charges/missing").await {
    Ok(resp) => { /* … */ }
    Err(meridian::Error::Provider(e)) => {
        println!("{:?} {} retryable={}", e.category(), e.status, e.retryable);
    }
    Err(e) => eprintln!("{e}"),
}
```

### Streaming (AI providers)

`stream_call` streams an SSE/token response, one `Chunk` per delta. Defaults to
`POST`.

```rust
use meridian::pb::CallRequest;

client.stream_call(
    CallRequest {
        provider: "anthropic".into(),
        endpoint: "/v1/messages".into(),
        body_json: serde_json::json!({ "model": "claude-opus-4-8", "stream": true }).to_string(),
        ..Default::default()
    },
    |chunk| println!("chunk {}: {}", chunk.index, chunk.data),
).await?;
```

### Health / capabilities

```rust
let h = client.health().await?; // unauthenticated
println!("{} {:?}", h.status, h.providers);
```

## Example

A complete runnable program is in [`examples/basic.rs`](examples/basic.rs):

```bash
docker compose up -d                       # from repo root
cd clients/rust
MERIDIAN_PROXY_TOKEN=... cargo run --example basic
```

## Relationship to the Go client

This mirrors the [Go reference client](../go) method-for-method. Both implement
the same [`proto/meridian.proto`](../../proto/meridian.proto), so identical calls
return identical normalized shapes. The Go client's
[conformance suite](../go/conformance) defines the contract both satisfy.
