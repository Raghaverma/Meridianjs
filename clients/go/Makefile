# Meridian Go client — developer tasks.
#
# The generated stubs under genproto/ are committed, so `go get` and `go build`
# work with no codegen tooling. Only run `make generate` after editing
# ../../proto/meridian.proto.

REPO_ROOT := $(shell cd ../.. && pwd)

.PHONY: generate build vet tidy example

## Regenerate gRPC stubs from the proto (uses buf in Docker — no local install).
generate:
	docker run --rm -v "$(REPO_ROOT)":/work -w /work/clients/go \
		bufbuild/buf:1.70.0 generate ../../proto
	go mod tidy

## Compile everything.
build:
	go build ./...

## Static checks.
vet:
	go vet ./...

## Resolve/prune module deps.
tidy:
	go mod tidy

## Run the example against a proxy on 127.0.0.1:4242.
example:
	go run ./example

## Run the black-box conformance suite end-to-end (starts a proxy in Docker).
conformance:
	./conformance/run.sh
