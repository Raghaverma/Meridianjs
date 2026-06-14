// Generate the gRPC client from the repo's single source of truth at build
// time. Requires `protoc` on PATH (e.g. `brew install protobuf`,
// `apt-get install -y protobuf-compiler`) — the standard tonic toolchain.
fn main() -> Result<(), Box<dyn std::error::Error>> {
    tonic_build::configure()
        .build_server(false)
        .compile_protos(&["../../proto/meridian.proto"], &["../../proto"])?;
    Ok(())
}
