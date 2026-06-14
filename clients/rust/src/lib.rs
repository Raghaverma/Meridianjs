//! Rust client for the [Meridian](https://github.com/Raghaverma/meridianjs)
//! Boundary Proxy.
//!
//! The reliability engine — retries, circuit breaking, rate limiting, secret
//! redaction, normalization across 46 providers — runs in the proxy. This crate
//! is a thin, async wrapper over the gRPC contract in `proto/meridian.proto`; it
//! holds no provider logic. Point it at a running proxy (see the repo's
//! `docker-compose.yml`) and call any provider through one stable interface:
//!
//! ```no_run
//! # async fn run() -> Result<(), meridian::Error> {
//! let client = meridian::Client::connect("127.0.0.1:4242", Some("token".into())).await?;
//! let resp = client.get("github", "/repos/octocat/Hello-World").await?;
//! println!("{}", resp.data);
//! # Ok(()) }
//! ```

use std::fmt;

use tonic::metadata::MetadataValue;
use tonic::transport::{Channel, Endpoint};
use tonic::Request;

/// Generated protobuf/gRPC types for the `meridian.v1` package.
pub mod pb {
    tonic::include_proto!("meridian.v1");
}

use pb::meridian_client::MeridianClient;
use pb::{CallRequest, CallResponse, HealthResponse, MeridianError as PbError, StreamChunk};

/// A connection to a Meridian Boundary Proxy. Cheap to clone (shares the
/// underlying channel) and safe to share across tasks.
#[derive(Clone)]
pub struct Client {
    inner: MeridianClient<Channel>,
    token: Option<String>,
}

/// A normalized successful response.
pub struct Response {
    /// The normalized response body, decoded from JSON.
    pub data: serde_json::Value,
    /// Provider, request id, rate-limit state, pagination, trace.
    pub meta: Option<pb::ResponseMeta>,
}

/// One delta of a server-streamed (SSE/token) response.
pub struct Chunk {
    /// The JSON-decoded delta.
    pub data: serde_json::Value,
    /// 0-based position in the stream.
    pub index: u32,
    /// SSE event name (empty when absent).
    pub event: String,
    /// Verbatim SSE data payload.
    pub raw: String,
}

/// Everything that can go wrong talking to the proxy.
#[derive(Debug)]
pub enum Error {
    /// Failed to establish the connection.
    Connect(tonic::transport::Error),
    /// A gRPC transport-level failure (e.g. UNAUTHENTICATED).
    Transport(tonic::Status),
    /// A normalized provider error — uniform across every provider.
    Provider(PbError),
    /// Failed to encode/decode a JSON body.
    Json(serde_json::Error),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Connect(e) => write!(f, "meridian: connect: {e}"),
            Error::Transport(s) => write!(f, "meridian: transport: {s}"),
            Error::Provider(e) => write!(
                f,
                "meridian: {} (provider={} category={:?} code={:?} status={} retryable={})",
                e.message,
                e.provider,
                e.category(),
                e.code(),
                e.status,
                e.retryable,
            ),
            Error::Json(e) => write!(f, "meridian: json: {e}"),
        }
    }
}

impl std::error::Error for Error {}

impl Error {
    /// Whether the proxy classified this failure as safe to retry.
    pub fn retryable(&self) -> bool {
        matches!(self, Error::Provider(e) if e.retryable)
    }
}

impl Client {
    /// Connect to the proxy at `addr` (e.g. `127.0.0.1:4242`). An `http://`
    /// scheme is assumed when none is given. `token` is the shared secret sent
    /// as `authorization: Bearer <token>` on every request — required whenever
    /// the proxy was started with `MERIDIAN_PROXY_TOKEN`.
    pub async fn connect(addr: impl Into<String>, token: Option<String>) -> Result<Self, Error> {
        let mut addr = addr.into();
        if !addr.starts_with("http://") && !addr.starts_with("https://") {
            addr = format!("http://{addr}");
        }
        let channel = Endpoint::from_shared(addr)
            .map_err(Error::Connect)?
            .connect()
            .await
            .map_err(Error::Connect)?;
        Ok(Self {
            inner: MeridianClient::new(channel),
            token,
        })
    }

    fn authed<T>(&self, msg: T) -> Request<T> {
        let mut req = Request::new(msg);
        if let Some(tok) = &self.token {
            if let Ok(value) = format!("Bearer {tok}").parse::<MetadataValue<_>>() {
                req.metadata_mut().insert("authorization", value);
            }
        }
        req
    }

    /// Execute a single request through the full pipeline.
    pub async fn call(&self, req: CallRequest) -> Result<Response, Error> {
        let resp: CallResponse = self
            .inner
            .clone()
            .call(self.authed(req))
            .await
            .map_err(Error::Transport)?
            .into_inner();
        into_response(resp)
    }

    /// GET `endpoint` from `provider`.
    pub async fn get(&self, provider: &str, endpoint: &str) -> Result<Response, Error> {
        self.call(build(provider, "GET", endpoint, None)?).await
    }

    /// DELETE `endpoint` on `provider`.
    pub async fn delete(&self, provider: &str, endpoint: &str) -> Result<Response, Error> {
        self.call(build(provider, "DELETE", endpoint, None)?).await
    }

    /// POST a JSON body to `endpoint` on `provider`.
    pub async fn post(
        &self,
        provider: &str,
        endpoint: &str,
        body: &serde_json::Value,
    ) -> Result<Response, Error> {
        self.call(build(provider, "POST", endpoint, Some(body))?).await
    }

    /// PUT a JSON body to `endpoint` on `provider`.
    pub async fn put(
        &self,
        provider: &str,
        endpoint: &str,
        body: &serde_json::Value,
    ) -> Result<Response, Error> {
        self.call(build(provider, "PUT", endpoint, Some(body))?).await
    }

    /// PATCH a JSON body to `endpoint` on `provider`.
    pub async fn patch(
        &self,
        provider: &str,
        endpoint: &str,
        body: &serde_json::Value,
    ) -> Result<Response, Error> {
        self.call(build(provider, "PATCH", endpoint, Some(body))?).await
    }

    /// Stream a Server-Sent-Events / token response (Anthropic, OpenAI, …),
    /// invoking `on_chunk` once per delta in order. The request defaults to
    /// POST unless `req.method` is set. A normalized provider failure is
    /// returned as `Error::Provider`.
    pub async fn stream_call<F>(&self, req: CallRequest, mut on_chunk: F) -> Result<(), Error>
    where
        F: FnMut(Chunk),
    {
        let mut stream = self
            .inner
            .clone()
            .stream_call(self.authed(req))
            .await
            .map_err(Error::Transport)?
            .into_inner();

        while let Some(msg) = stream.message().await.map_err(Error::Transport)? {
            if let Some(err) = &msg.error {
                if !err.message.is_empty() {
                    return Err(Error::Provider(err.clone()));
                }
            }
            if msg.done {
                return Ok(());
            }
            on_chunk(into_chunk(msg)?);
        }
        Ok(())
    }

    /// Unauthenticated liveness + capability probe.
    pub async fn health(&self) -> Result<HealthResponse, Error> {
        Ok(self
            .inner
            .clone()
            .health(Request::new(pb::HealthRequest {}))
            .await
            .map_err(Error::Transport)?
            .into_inner())
    }
}

fn build(
    provider: &str,
    method: &str,
    endpoint: &str,
    body: Option<&serde_json::Value>,
) -> Result<CallRequest, Error> {
    let body_json = match body {
        Some(v) => serde_json::to_string(v).map_err(Error::Json)?,
        None => String::new(),
    };
    Ok(CallRequest {
        provider: provider.to_string(),
        method: method.to_string(),
        endpoint: endpoint.to_string(),
        body_json,
        ..Default::default()
    })
}

fn into_response(resp: CallResponse) -> Result<Response, Error> {
    if let Some(err) = resp.error {
        if !err.message.is_empty() {
            return Err(Error::Provider(err));
        }
    }
    let data = decode_json(&resp.data_json)?;
    Ok(Response {
        data,
        meta: resp.meta,
    })
}

fn into_chunk(msg: StreamChunk) -> Result<Chunk, Error> {
    Ok(Chunk {
        data: decode_json(&msg.data_json)?,
        index: msg.index,
        event: msg.event,
        raw: msg.raw,
    })
}

fn decode_json(s: &str) -> Result<serde_json::Value, Error> {
    if s.is_empty() {
        return Ok(serde_json::Value::Null);
    }
    serde_json::from_str(s).map_err(Error::Json)
}
