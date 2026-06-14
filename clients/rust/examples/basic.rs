//! Runnable example for the Meridian Rust client.
//!
//! Start the proxy first (from the repo root):
//!
//! ```bash
//! cp .env.example .env   # set MERIDIAN_PROXY_TOKEN, GITHUB_TOKEN
//! docker compose up -d
//! ```
//!
//! Then run:
//!
//! ```bash
//! cd clients/rust
//! MERIDIAN_PROXY_TOKEN=... cargo run --example basic
//! ```

use meridian::Client;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let addr = std::env::var("MERIDIAN_PROXY_ADDR").unwrap_or_else(|_| "127.0.0.1:4242".into());
    let token = std::env::var("MERIDIAN_PROXY_TOKEN").ok();

    let client = Client::connect(addr.clone(), token).await?;

    // 1) Unauthenticated liveness + capability probe.
    let health = client.health().await?;
    println!(
        "proxy status={}, {} providers available",
        health.status,
        health.providers.len()
    );

    // 2) A real normalized call. Same shape for any of the 46 providers.
    match client.get("github", "/repos/octocat/Hello-World").await {
        Ok(resp) => {
            let full_name = resp.data.get("full_name").and_then(|v| v.as_str()).unwrap_or("?");
            let stars = resp.data.get("stargazers_count").and_then(|v| v.as_i64()).unwrap_or(0);
            println!("{full_name} — {stars} stars");
            if let Some(meta) = resp.meta {
                println!("request_id={} provider={}", meta.request_id, meta.provider);
            }
        }
        Err(e) => eprintln!("github call failed: {e} (retryable={})", e.retryable()),
    }

    Ok(())
}
