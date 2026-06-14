package conformance

import (
	"context"
	"os"
	"testing"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"

	meridianv1 "github.com/Raghaverma/meridianjs/clients/go/genproto/meridianv1"
)

func addr() string {
	if v := os.Getenv("MERIDIAN_PROXY_ADDR"); v != "" {
		return v
	}
	return "127.0.0.1:4242"
}

func token() string { return os.Getenv("MERIDIAN_PROXY_TOKEN") }

// dial returns a raw contract client, or skips the test if no proxy answers a
// Health probe at MERIDIAN_PROXY_ADDR.
func dial(t *testing.T) meridianv1.MeridianClient {
	t.Helper()
	conn, err := grpc.NewClient(addr(), grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		t.Fatalf("dial %s: %v", addr(), err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	client := meridianv1.NewMeridianClient(conn)

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if _, err := client.Health(ctx, &meridianv1.HealthRequest{}); err != nil {
		t.Skipf("no proxy reachable at %s (%v) — set MERIDIAN_PROXY_ADDR to run conformance", addr(), err)
	}
	return client
}

func withToken(ctx context.Context) context.Context {
	if token() == "" {
		return ctx
	}
	return metadata.AppendToOutgoingContext(ctx, "authorization", "Bearer "+token())
}

func ctx(t *testing.T) (context.Context, context.CancelFunc) {
	t.Helper()
	return context.WithTimeout(context.Background(), 10*time.Second)
}

// 1. Health is unauthenticated and advertises the provider catalog.
func TestHealthIsUnauthenticatedAndListsProviders(t *testing.T) {
	client := dial(t)
	c, cancel := ctx(t)
	defer cancel()

	// No token attached on purpose.
	res, err := client.Health(c, &meridianv1.HealthRequest{})
	if err != nil {
		t.Fatalf("Health must succeed without a token: %v", err)
	}
	if res.GetStatus() == "" {
		t.Error("Health.status must be non-empty")
	}
	if len(res.GetProviders()) == 0 {
		t.Error("Health.providers must list the supported providers")
	}
}

// 2. Call is rejected without a token when the proxy requires one.
func TestCallRejectedWithoutToken(t *testing.T) {
	client := dial(t)
	if token() == "" {
		t.Skip("proxy under test has no token configured; start it with MERIDIAN_PROXY_TOKEN")
	}
	c, cancel := ctx(t)
	defer cancel()

	_, err := client.Call(c, &meridianv1.CallRequest{
		Provider: "github", Method: "GET", Endpoint: "/rate_limit",
	})
	if status.Code(err) != codes.Unauthenticated {
		t.Fatalf("expected UNAUTHENTICATED without a token, got %v", err)
	}
}

// 3. Call is rejected with a wrong token.
func TestCallRejectedWithWrongToken(t *testing.T) {
	client := dial(t)
	if token() == "" {
		t.Skip("proxy under test has no token configured")
	}
	c, cancel := ctx(t)
	defer cancel()

	bad := metadata.AppendToOutgoingContext(c, "authorization", "Bearer definitely-wrong")
	_, err := client.Call(bad, &meridianv1.CallRequest{
		Provider: "github", Method: "GET", Endpoint: "/rate_limit",
	})
	if status.Code(err) != codes.Unauthenticated {
		t.Fatalf("expected UNAUTHENTICATED with a wrong token, got %v", err)
	}
}

// 4. Call is accepted with the correct token (no transport-level rejection).
//    Without provider creds the upstream may still error, but that arrives as a
//    NORMALIZED in-band error, never an UNAUTHENTICATED transport status.
func TestCallAcceptedWithToken(t *testing.T) {
	client := dial(t)
	c, cancel := ctx(t)
	defer cancel()

	_, err := client.Call(withToken(c), &meridianv1.CallRequest{
		Provider: "github", Method: "GET", Endpoint: "/rate_limit",
	})
	if status.Code(err) == codes.Unauthenticated {
		t.Fatalf("a correct token must be accepted, got UNAUTHENTICATED: %v", err)
	}
	if err != nil {
		t.Fatalf("Call transport must succeed with a token; errors are in-band: %v", err)
	}
}

// 5. StreamCall enforces the same auth as Call.
func TestStreamCallRejectedWithoutToken(t *testing.T) {
	client := dial(t)
	if token() == "" {
		t.Skip("proxy under test has no token configured")
	}
	c, cancel := ctx(t)
	defer cancel()

	stream, err := client.StreamCall(c, &meridianv1.CallRequest{
		Provider: "anthropic", Method: "POST", Endpoint: "/v1/messages",
	})
	if err == nil {
		_, err = stream.Recv() // status is delivered on first Recv for server streams
	}
	if status.Code(err) != codes.Unauthenticated {
		t.Fatalf("expected UNAUTHENTICATED StreamCall without a token, got %v", err)
	}
}

// 6. Absolute / protocol-relative endpoints are rejected (SSRF guard). The
//    failure is a NORMALIZED in-band validation error, not a redirect.
func TestAbsoluteEndpointRejected(t *testing.T) {
	client := dial(t)
	c, cancel := ctx(t)
	defer cancel()

	for _, evil := range []string{"https://attacker.example/steal", "//attacker.example/x"} {
		res, err := client.Call(withToken(c), &meridianv1.CallRequest{
			Provider: "github", Method: "GET", Endpoint: evil,
		})
		if err != nil {
			t.Fatalf("transport error for %q (expected in-band error): %v", evil, err)
		}
		e := res.GetError()
		if e == nil || e.GetMessage() == "" {
			t.Fatalf("endpoint %q must be rejected with a normalized error, got %+v", evil, res)
		}
		if e.GetCategory() != meridianv1.ErrorCategory_VALIDATION {
			t.Errorf("endpoint %q should be a VALIDATION error, got %s", evil, e.GetCategory())
		}
	}
}

// 7. An unknown provider yields a normalized error, not a crash.
func TestUnknownProviderNormalizedError(t *testing.T) {
	client := dial(t)
	c, cancel := ctx(t)
	defer cancel()

	res, err := client.Call(withToken(c), &meridianv1.CallRequest{
		Provider: "not-a-real-provider", Method: "GET", Endpoint: "/x",
	})
	if err != nil {
		t.Fatalf("unknown provider must be an in-band error, got transport error: %v", err)
	}
	if res.GetError() == nil || res.GetError().GetProvider() != "not-a-real-provider" {
		t.Fatalf("expected a normalized error naming the provider, got %+v", res.GetError())
	}
}

// 8. Provider errors are normalized to the MeridianError shape (category/code/
//    retryable/status), uniform across providers. With no GITHUB_TOKEN the
//    proxy's call is unauthorized upstream, which must surface as a normalized
//    error — exercising the normalization contract without real credentials.
func TestNormalizedErrorShape(t *testing.T) {
	client := dial(t)
	c, cancel := ctx(t)
	defer cancel()

	res, err := client.Call(withToken(c), &meridianv1.CallRequest{
		Provider: "github", Method: "GET", Endpoint: "/repos/this-org/does-not-exist-xyz",
	})
	if err != nil {
		t.Fatalf("transport error (expected in-band): %v", err)
	}
	e := res.GetError()
	if e == nil {
		t.Skip("upstream unexpectedly succeeded (credentials present?) — nothing to assert")
	}
	// The shape, not the specific value, is the contract: a category and code
	// are always present, and the provider is tagged.
	if e.GetCategory() == meridianv1.ErrorCategory_ERROR_CATEGORY_UNSPECIFIED {
		t.Error("normalized error must carry a category")
	}
	if e.GetCode() == meridianv1.ErrorCode_ERROR_CODE_UNSPECIFIED {
		t.Error("normalized error must carry a code")
	}
	if e.GetProvider() != "github" {
		t.Errorf("normalized error must name the provider, got %q", e.GetProvider())
	}
}
