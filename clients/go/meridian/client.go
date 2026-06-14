// Package meridian is the Go client for the Meridian Boundary Proxy.
//
// Meridian's engine — retries, circuit breaking, rate limiting, secret
// redaction, response normalization across 46 providers — runs once, inside the
// proxy. This package is a thin, ergonomic wrapper over the gRPC contract in
// proto/meridian.proto; it contains no provider logic of its own. Point it at a
// running proxy (see the repo's docker-compose.yml) and call any provider
// through one stable interface:
//
//	c, err := meridian.Dial(ctx, "127.0.0.1:4242", meridian.WithToken(os.Getenv("MERIDIAN_PROXY_TOKEN")))
//	if err != nil { log.Fatal(err) }
//	defer c.Close()
//
//	resp, err := c.Get(ctx, "github", "/repos/octocat/Hello-World")
//	if err != nil { log.Fatal(err) }
//
//	var repo struct{ FullName string `json:"full_name"` }
//	_ = resp.Decode(&repo)
package meridian

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"

	meridianv1 "github.com/Raghaverma/meridianjs/clients/go/genproto/meridianv1"
)

// Client is a connection to a Meridian Boundary Proxy. It is safe for
// concurrent use by multiple goroutines.
type Client struct {
	conn  *grpc.ClientConn
	rpc   meridianv1.MeridianClient
	token string
}

type dialConfig struct {
	token     string
	creds     credentials.TransportCredentials
	extraOpts []grpc.DialOption
}

// Option configures Dial.
type Option func(*dialConfig)

// WithToken sets the shared secret sent as "authorization: Bearer <token>" on
// every request. Required whenever the proxy was started with
// MERIDIAN_PROXY_TOKEN (the default for any non-loopback deployment).
func WithToken(token string) Option {
	return func(c *dialConfig) { c.token = token }
}

// WithTLS dials the proxy over TLS. Use this when the proxy is not co-located
// on loopback. Pass nil for the platform default client config.
func WithTLS(cfg *tls.Config) Option {
	return func(c *dialConfig) { c.creds = credentials.NewTLS(cfg) }
}

// WithDialOptions appends raw grpc.DialOptions for advanced tuning
// (keepalives, interceptors, message sizes, …).
func WithDialOptions(opts ...grpc.DialOption) Option {
	return func(c *dialConfig) { c.extraOpts = append(c.extraOpts, opts...) }
}

// Dial connects to the proxy at target (e.g. "127.0.0.1:4242"). The connection
// is established lazily; the first RPC reports an unreachable proxy. Call Close
// when done.
func Dial(_ context.Context, target string, opts ...Option) (*Client, error) {
	cfg := &dialConfig{creds: insecure.NewCredentials()}
	for _, opt := range opts {
		opt(cfg)
	}

	dialOpts := append([]grpc.DialOption{grpc.WithTransportCredentials(cfg.creds)}, cfg.extraOpts...)
	conn, err := grpc.NewClient(target, dialOpts...)
	if err != nil {
		return nil, fmt.Errorf("meridian: dial %s: %w", target, err)
	}
	return &Client{conn: conn, rpc: meridianv1.NewMeridianClient(conn), token: cfg.token}, nil
}

// Close releases the underlying connection.
func (c *Client) Close() error { return c.conn.Close() }

// Request is a single normalized call. Provider and Endpoint are required;
// everything else is optional.
type Request struct {
	Provider string            // e.g. "github", "stripe", "anthropic"
	Method   string            // GET|POST|PUT|PATCH|DELETE (defaults to GET)
	Endpoint string            // relative path, e.g. "/repos/octocat/Hello-World"
	Query    map[string]string // query-string params
	Headers  map[string]string // forwarded per the proxy's header allowlist
	Body     any               // JSON-encoded for the request body (nil = none)
	// IdempotencyKey makes a write safely retryable; the proxy can also
	// auto-generate one. Optional.
	IdempotencyKey string
	// Timeout overrides the adapter default for this call. Optional.
	Timeout time.Duration
	// Identity tags the call for the proxy's SOC 2 audit log. Optional.
	Identity string
}

// Response is a normalized successful reply.
type Response struct {
	// Data is the normalized response body as raw JSON. Use Decode to unmarshal.
	Data json.RawMessage
	// Meta carries provider, request id, rate-limit state, pagination, trace.
	Meta *meridianv1.ResponseMeta
}

// Decode unmarshals the response body into v.
func (r *Response) Decode(v any) error {
	if len(r.Data) == 0 {
		return nil
	}
	if err := json.Unmarshal(r.Data, v); err != nil {
		return fmt.Errorf("meridian: decode response: %w", err)
	}
	return nil
}

// Error is a normalized failure returned by the proxy. It is uniform across
// every provider, so callers branch on Category/Code/Retryable rather than
// provider-specific shapes.
type Error struct{ *meridianv1.MeridianError }

func (e *Error) Error() string {
	return fmt.Sprintf("meridian: %s (provider=%s category=%s code=%s status=%d retryable=%t)",
		e.GetMessage(), e.GetProvider(), e.GetCategory(), e.GetCode(), e.GetStatus(), e.GetRetryable())
}

// Retryable reports whether the proxy classified this failure as safe to retry.
func (e *Error) Retryable() bool { return e.GetRetryable() }

func (c *Client) withAuth(ctx context.Context) context.Context {
	if c.token == "" {
		return ctx
	}
	return metadata.AppendToOutgoingContext(ctx, "authorization", "Bearer "+c.token)
}

func (c *Client) toProto(req Request) (*meridianv1.CallRequest, error) {
	method := req.Method
	if method == "" {
		method = "GET"
	}
	bodyJSON := ""
	if req.Body != nil {
		b, err := json.Marshal(req.Body)
		if err != nil {
			return nil, fmt.Errorf("meridian: encode request body: %w", err)
		}
		bodyJSON = string(b)
	}
	return &meridianv1.CallRequest{
		Provider:       req.Provider,
		Method:         method,
		Endpoint:       req.Endpoint,
		Query:          req.Query,
		Headers:        req.Headers,
		BodyJson:       bodyJSON,
		IdempotencyKey: req.IdempotencyKey,
		TimeoutMs:      int32(req.Timeout.Milliseconds()),
		Identity:       req.Identity,
	}, nil
}

func toResponse(res *meridianv1.CallResponse) (*Response, error) {
	if e := res.GetError(); e != nil && e.GetMessage() != "" {
		return nil, &Error{e}
	}
	var data json.RawMessage
	if s := res.GetDataJson(); s != "" {
		data = json.RawMessage(s)
	}
	return &Response{Data: data, Meta: res.GetMeta()}, nil
}

// Do executes a single request through the full pipeline.
func (c *Client) Do(ctx context.Context, req Request) (*Response, error) {
	pb, err := c.toProto(req)
	if err != nil {
		return nil, err
	}
	res, err := c.rpc.Call(c.withAuth(ctx), pb)
	if err != nil {
		return nil, fmt.Errorf("meridian: call %s %s: %w", req.Provider, req.Endpoint, err)
	}
	return toResponse(res)
}

// Get issues a GET. Extra fields (query, headers, …) can be set via opts.
func (c *Client) Get(ctx context.Context, provider, endpoint string, opts ...RequestOption) (*Response, error) {
	return c.Do(ctx, build(provider, "GET", endpoint, nil, opts))
}

// Delete issues a DELETE.
func (c *Client) Delete(ctx context.Context, provider, endpoint string, opts ...RequestOption) (*Response, error) {
	return c.Do(ctx, build(provider, "DELETE", endpoint, nil, opts))
}

// Post issues a POST with a JSON body.
func (c *Client) Post(ctx context.Context, provider, endpoint string, body any, opts ...RequestOption) (*Response, error) {
	return c.Do(ctx, build(provider, "POST", endpoint, body, opts))
}

// Put issues a PUT with a JSON body.
func (c *Client) Put(ctx context.Context, provider, endpoint string, body any, opts ...RequestOption) (*Response, error) {
	return c.Do(ctx, build(provider, "PUT", endpoint, body, opts))
}

// Patch issues a PATCH with a JSON body.
func (c *Client) Patch(ctx context.Context, provider, endpoint string, body any, opts ...RequestOption) (*Response, error) {
	return c.Do(ctx, build(provider, "PATCH", endpoint, body, opts))
}

// Paginate traverses a paginated endpoint, invoking fn once per page in order.
// Return a non-nil error from fn to stop early; that error is returned.
func (c *Client) Paginate(ctx context.Context, req Request, fn func(*Response) error) error {
	pb, err := c.toProto(req)
	if err != nil {
		return err
	}
	stream, err := c.rpc.Paginate(c.withAuth(ctx), pb)
	if err != nil {
		return fmt.Errorf("meridian: paginate %s %s: %w", req.Provider, req.Endpoint, err)
	}
	for {
		msg, err := stream.Recv()
		if err != nil {
			if errors.Is(err, io.EOF) { // stream completed normally
				return nil
			}
			return fmt.Errorf("meridian: paginate recv: %w", err)
		}
		page, perr := toResponse(msg)
		if perr != nil {
			return perr
		}
		if ferr := fn(page); ferr != nil {
			return ferr
		}
	}
}

// Chunk is one delta of a server-streamed (SSE/token) response.
type Chunk struct {
	// Data is the JSON-encoded delta. Use Decode to unmarshal.
	Data json.RawMessage
	// Index is the 0-based position of this chunk in the stream.
	Index uint32
	// Event is the SSE event name ("" when absent).
	Event string
	// Raw is the verbatim SSE data payload.
	Raw string
}

// Decode unmarshals the chunk's delta into v.
func (ch *Chunk) Decode(v any) error {
	if len(ch.Data) == 0 {
		return nil
	}
	if err := json.Unmarshal(ch.Data, v); err != nil {
		return fmt.Errorf("meridian: decode chunk: %w", err)
	}
	return nil
}

// StreamCall streams a Server-Sent-Events / token response (Anthropic, OpenAI,
// …), invoking fn once per delta in order. The request defaults to POST unless
// req.Method is set. Return a non-nil error from fn to stop early; that error
// is returned. A normalized provider failure is returned as a *Error.
func (c *Client) StreamCall(ctx context.Context, req Request, fn func(*Chunk) error) error {
	pb, err := c.toProto(req)
	if err != nil {
		return err
	}
	stream, err := c.rpc.StreamCall(c.withAuth(ctx), pb)
	if err != nil {
		return fmt.Errorf("meridian: streamcall %s %s: %w", req.Provider, req.Endpoint, err)
	}
	for {
		msg, rerr := stream.Recv()
		if rerr != nil {
			if errors.Is(rerr, io.EOF) { // stream completed normally
				return nil
			}
			return fmt.Errorf("meridian: streamcall recv: %w", rerr)
		}
		if e := msg.GetError(); e != nil && e.GetMessage() != "" {
			return &Error{e}
		}
		if msg.GetDone() { // terminal sentinel
			return nil
		}
		ch := &Chunk{Index: msg.GetIndex(), Event: msg.GetEvent(), Raw: msg.GetRaw()}
		if s := msg.GetDataJson(); s != "" {
			ch.Data = json.RawMessage(s)
		}
		if ferr := fn(ch); ferr != nil {
			return ferr
		}
	}
}

// Health is an unauthenticated liveness + capability probe. It returns the
// status string and the list of providers the proxy can serve.
func (c *Client) Health(ctx context.Context) (*meridianv1.HealthResponse, error) {
	res, err := c.rpc.Health(ctx, &meridianv1.HealthRequest{})
	if err != nil {
		return nil, fmt.Errorf("meridian: health: %w", err)
	}
	return res, nil
}

// RequestOption tweaks a convenience-method request (Get/Post/…).
type RequestOption func(*Request)

// WithQuery sets query-string parameters.
func WithQuery(q map[string]string) RequestOption {
	return func(r *Request) { r.Query = q }
}

// WithHeaders sets request headers (subject to the proxy's forward allowlist).
func WithHeaders(h map[string]string) RequestOption {
	return func(r *Request) { r.Headers = h }
}

// WithIdempotencyKey sets an idempotency key for a safe retry.
func WithIdempotencyKey(key string) RequestOption {
	return func(r *Request) { r.IdempotencyKey = key }
}

// WithTimeout overrides the adapter default for this call.
func WithTimeout(d time.Duration) RequestOption {
	return func(r *Request) { r.Timeout = d }
}

// WithIdentity tags the call for the proxy's audit log.
func WithIdentity(id string) RequestOption {
	return func(r *Request) { r.Identity = id }
}

func build(provider, method, endpoint string, body any, opts []RequestOption) Request {
	req := Request{Provider: provider, Method: method, Endpoint: endpoint, Body: body}
	for _, opt := range opts {
		opt(&req)
	}
	return req
}
