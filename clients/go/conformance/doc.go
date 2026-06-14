// Package conformance is a black-box contract test for the Meridian Boundary
// Proxy. It asserts the invariants every language binding relies on, directly
// at the gRPC layer (the contract), against a RUNNING proxy.
//
// It does not start a proxy itself — point it at one and run:
//
//	MERIDIAN_PROXY_ADDR=127.0.0.1:4242 MERIDIAN_PROXY_TOKEN=secret go test ./conformance -v
//
// The proxy under test MUST be started WITH a token (MERIDIAN_PROXY_TOKEN) so
// the auth-enforcement invariants are exercised. Provider credentials are NOT
// required: every assertion here is credential-free. If no proxy is reachable,
// the tests skip rather than fail, so `go test ./...` stays green in plain CI.
//
// The orchestrated runner conformance/run.sh starts a proxy in Docker and runs
// this suite against it end-to-end.
package conformance
