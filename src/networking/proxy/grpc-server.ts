import { appendFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// Types only — the actual modules are loaded lazily in start() so the SDK core
// stays dependency-free. @grpc/* are optional peer dependencies needed only when
// you run the Boundary Proxy.
import type * as grpc from "@grpc/grpc-js";
import type { StreamChunk } from "../../core/streaming.js";
import type {
  MeridianErrorCategory,
  NormalizedResponse,
  RateLimitInfo,
  RequestOptions,
  ResponseMeta,
} from "../../core/types.js";
import { MeridianError } from "../../core/types.js";
import { Meridian } from "../../index.js";
import {
  buildMeridianConfig,
  DEFAULT_FORWARDED_HEADERS,
  isLoopbackHost,
  loadReplayMap,
  PROVIDER_CATEGORIES,
  type ProxyServerOptions,
  SUPPORTED_PROVIDERS,
  safeEqual,
  sanitizeForRecord,
} from "./shared.js";

const PROTO_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../proto/meridian.proto",
);

const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024;

export interface GrpcProxyServerOptions extends ProxyServerOptions {
  /**
   * Maximum incoming message size in bytes. Larger messages are rejected by the
   * gRPC transport (RESOURCE_EXHAUSTED) before reaching a handler. Defaults to 10 MB.
   */
  maxBodyBytes?: number;
}

/** Maps the internal error category to the proto ErrorCategory enum name. */
function categoryToProto(category: MeridianErrorCategory): string {
  switch (category) {
    case "auth":
      return "AUTH";
    case "rate_limit":
      return "RATE_LIMIT";
    case "network":
      return "NETWORK";
    case "provider":
      return "PROVIDER";
    case "validation":
      return "VALIDATION";
    default:
      return "ERROR_CATEGORY_UNSPECIFIED";
  }
}

/** Accepts Date | epoch-millis | ISO string and returns epoch millis. */
function toEpochMillis(value: unknown): number {
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

function rateLimitToProto(rl: RateLimitInfo | undefined): Record<string, unknown> {
  return {
    limit: rl?.limit ?? 0,
    remaining: rl?.remaining ?? 0,
    reset_unix_ms: toEpochMillis(rl?.reset),
  };
}

function metaToProto(meta: ResponseMeta): Record<string, unknown> {
  const out: Record<string, unknown> = {
    provider: meta.provider,
    request_id: meta.requestId,
    rate_limit: rateLimitToProto(meta.rateLimit),
    warnings: meta.warnings ?? [],
    schema_version: meta.schemaVersion,
  };
  if (meta.pagination) {
    out.pagination = {
      has_next: meta.pagination.hasNext,
      cursor: meta.pagination.cursor ?? "",
      total: meta.pagination.total ?? 0,
      has_total: meta.pagination.total !== undefined,
    };
  }
  if (meta.trace) {
    out.trace = {
      retries: meta.trace.retries,
      latency_ms: meta.trace.latency,
      circuit_breaker: meta.trace.circuitBreaker,
      rate_limit_remaining: meta.trace.rateLimitRemaining,
    };
  }
  return out;
}

/** A normalized SDK response → CallResponse proto object. */
function normalizedToProto(response: NormalizedResponse): Record<string, unknown> {
  return {
    data_json: JSON.stringify(response.data ?? null),
    meta: metaToProto(response.meta),
  };
}

/** A recorded `{ data, meta }` object (from a replay file) → CallResponse proto object. */
function recordedToProto(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && "data" in value && "meta" in value) {
    return normalizedToProto(value as NormalizedResponse);
  }
  // Not a normalized shape — surface the whole recorded payload as data.
  return { data_json: JSON.stringify(value ?? null) };
}

/** An SDK StreamChunk → StreamChunk proto object (a non-terminal delta). */
function chunkToProto(chunk: StreamChunk, index: number): Record<string, unknown> {
  return {
    data_json: JSON.stringify(chunk.data ?? null),
    index,
    event: chunk.event ?? "",
    raw: chunk.raw ?? "",
    done: false,
  };
}

/** Any thrown error → CallResponse proto object with `error` populated. */
function errorToProto(err: unknown, provider: string): Record<string, unknown> {
  if (err instanceof MeridianError) {
    return {
      error: {
        message: err.message,
        category: categoryToProto(err.category),
        code: err.code,
        retryable: err.retryable,
        provider: err.provider || provider,
        request_id: err.requestId,
        status: err.status ?? 0,
        metadata_json: err.metadata ? JSON.stringify(err.metadata) : "",
        retry_after_unix_ms: err.retryAfter ? err.retryAfter.getTime() : 0,
      },
    };
  }
  const status =
    typeof (err as Record<string, unknown>)?.status === "number"
      ? ((err as Record<string, unknown>).status as number)
      : 0;
  return {
    error: {
      message: err instanceof Error ? err.message : String(err),
      category: "PROVIDER",
      code: "UNKNOWN",
      retryable: false,
      provider,
      request_id: "",
      status,
      metadata_json: "",
      retry_after_unix_ms: 0,
    },
  };
}

interface CallRequestMsg {
  provider: string;
  method: string;
  endpoint: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body_json: string;
  idempotency_key: string;
  timeout_ms: number;
  identity: string;
}

export class BoundaryGrpcServer {
  private meridian: Meridian | null = null;
  private server: grpc.Server | null = null;
  private readonly port: number;
  private readonly host: string;
  private readonly opts: GrpcProxyServerOptions;
  private readonly recordTo: string | undefined;
  private readonly replayFrom: string | undefined;
  private readonly recordRedaction: boolean | "india";
  private readonly authToken: string | undefined;
  private readonly allowUnauthenticatedRemote: boolean;
  private readonly forwardedHeaders: Set<string>;
  private readonly maxBodyBytes: number;
  private replayMap: Map<string, unknown> = new Map();
  // Lazily-loaded @grpc/grpc-js module; set in start(), used by handlers.
  private grpcLib!: typeof import("@grpc/grpc-js");

  constructor(opts: GrpcProxyServerOptions = {}) {
    this.opts = opts;
    this.port = opts.port ?? 4242;
    this.host = opts.host ?? "127.0.0.1";
    this.recordTo = opts.recordTo ?? process.env.MERIDIAN_RECORD_PATH;
    this.replayFrom = opts.replayFrom ?? process.env.MERIDIAN_REPLAY_PATH;
    this.recordRedaction = opts.recordRedaction ?? true;
    this.authToken = opts.authToken ?? process.env.MERIDIAN_PROXY_TOKEN ?? undefined;
    this.allowUnauthenticatedRemote = opts.allowUnauthenticatedRemote ?? false;
    this.forwardedHeaders = new Set(DEFAULT_FORWARDED_HEADERS);
    for (const h of opts.forwardHeaders ?? []) {
      const lower = h.toLowerCase();
      // Never allow credential-bearing headers to be forwarded upstream.
      if (lower !== "authorization" && lower !== "cookie") {
        this.forwardedHeaders.add(lower);
      }
    }
    this.maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

    if (this.replayFrom) {
      this.replayMap = loadReplayMap(this.replayFrom);
    }
  }

  async start(): Promise<void> {
    const remoteBind = !isLoopbackHost(this.host);

    // Refuse to expose credentialed providers to the network without auth.
    if (remoteBind && !this.authToken && !this.allowUnauthenticatedRemote) {
      throw new Error(
        `[Meridian Proxy] Refusing to bind to non-loopback host "${this.host}" without an ` +
          "authToken. Anyone who can reach this port could spend your provider credentials. " +
          "Set `authToken` (or MERIDIAN_PROXY_TOKEN), bind to 127.0.0.1, or explicitly pass " +
          "`allowUnauthenticatedRemote: true` to override.",
      );
    }

    this.meridian = await Meridian.create(buildMeridianConfig(this.opts));

    // Lazy-load the optional gRPC peer dependencies. Surfacing a clear install
    // hint is friendlier than a raw module-not-found stack.
    const [grpcLib, protoLoader] = await Promise.all([
      import("@grpc/grpc-js").catch(() => {
        throw new Error(
          "The Boundary Proxy requires '@grpc/grpc-js' and '@grpc/proto-loader'. " +
            "Install them with: npm install @grpc/grpc-js @grpc/proto-loader",
        );
      }),
      import("@grpc/proto-loader"),
    ]);
    this.grpcLib = grpcLib;

    const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
      keepCase: true,
      longs: Number,
      enums: String,
      defaults: true,
      oneofs: true,
    });
    const proto = grpcLib.loadPackageDefinition(packageDefinition) as unknown as {
      meridian: { v1: { Meridian: { service: grpc.ServiceDefinition } } };
    };

    const server = new grpcLib.Server({
      "grpc.max_receive_message_length": this.maxBodyBytes,
      "grpc.max_send_message_length": this.maxBodyBytes,
    });

    server.addService(proto.meridian.v1.Meridian.service, {
      Health: this.handleHealth.bind(this),
      Call: this.handleCall.bind(this),
      Paginate: this.handlePaginate.bind(this),
      StreamCall: this.handleStreamCall.bind(this),
    } satisfies grpc.UntypedServiceImplementation);

    await new Promise<void>((resolveBind, rejectBind) => {
      server.bindAsync(
        `${this.host}:${this.port}`,
        grpcLib.ServerCredentials.createInsecure(),
        (err, _boundPort) => {
          if (err) {
            rejectBind(err);
            return;
          }
          resolveBind();
        },
      );
    });
    this.server = server;

    const target = `${this.host}:${this.port}`;
    console.log(`[Meridian Proxy] gRPC listening on ${target} (service meridian.v1.Meridian)`);
    if (this.authToken) {
      console.log(
        "[Meridian Proxy] Auth: required (metadata 'authorization: Bearer <token>' or 'x-proxy-token')",
      );
    } else {
      console.warn(
        "[Meridian Proxy] Auth: DISABLED — any caller that can reach this port can use your " +
          "provider credentials. Set authToken / MERIDIAN_PROXY_TOKEN to require a shared secret.",
      );
    }
    if (remoteBind) {
      console.warn(
        `[Meridian Proxy] WARNING: bound to non-loopback host "${this.host}". The proxy is ` +
          "reachable from the network. Ensure auth is enabled and the port is firewalled.",
      );
    }
    console.log(`[Meridian Proxy] ${SUPPORTED_PROVIDERS.length} providers available:`);
    for (const [category, providers] of Object.entries(PROVIDER_CATEGORIES)) {
      const label = `  ${category}:`.padEnd(16);
      console.log(`${label}${providers.join(", ")}`);
    }
    if (this.recordTo) {
      const piiMode =
        this.recordRedaction === false
          ? "credentials only"
          : this.recordRedaction === "india"
            ? "credentials + PII (india)"
            : "credentials + PII";
      console.log(
        `[Meridian Proxy] Recording to ${this.recordTo} (redaction: ${piiMode}). ` +
          "Recording files are sensitive — store and share them with care.",
      );
    }
  }

  /** Gracefully stop the server. */
  async stop(): Promise<void> {
    const server = this.server;
    if (!server) {
      return;
    }
    await new Promise<void>((resolveShutdown) => {
      server.tryShutdown(() => resolveShutdown());
    });
    this.server = null;
  }

  /**
   * Constant-time check that the call carries the configured proxy token via
   * gRPC metadata: `authorization: Bearer <token>` or `x-proxy-token: <token>`.
   */
  private isAuthorized(metadata: grpc.Metadata): boolean {
    if (!this.authToken) {
      return true;
    }
    const authHeader = metadata.get("authorization")[0];
    if (typeof authHeader === "string") {
      const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
      if (match?.[1] && safeEqual(match[1], this.authToken)) {
        return true;
      }
    }
    const proxyToken = metadata.get("x-proxy-token")[0];
    if (typeof proxyToken === "string" && safeEqual(proxyToken, this.authToken)) {
      return true;
    }
    return false;
  }

  private handleHealth(
    _call: grpc.ServerUnaryCall<unknown, unknown>,
    callback: grpc.sendUnaryData<Record<string, unknown>>,
  ): void {
    callback(null, {
      status: "ok",
      providers: [...SUPPORTED_PROVIDERS],
      recording: Boolean(this.recordTo),
      replaying: Boolean(this.replayFrom),
      auth_required: Boolean(this.authToken),
    });
  }

  /** Build RequestOptions from a decoded CallRequest, applying the header allowlist. */
  private buildOptions(req: CallRequestMsg): { method: string; options: RequestOptions } {
    const method = (req.method || "GET").toUpperCase();

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers ?? {})) {
      if (this.forwardedHeaders.has(k.toLowerCase())) {
        headers[k] = v;
      }
    }

    const options: RequestOptions = { method: method as NonNullable<RequestOptions["method"]> };
    if (Object.keys(headers).length > 0) {
      options.headers = headers;
    }
    if (req.query && Object.keys(req.query).length > 0) {
      options.query = req.query;
    }
    if (req.body_json) {
      try {
        options.body = JSON.parse(req.body_json);
      } catch {
        options.body = req.body_json;
      }
    }
    if (req.idempotency_key) {
      options.idempotencyKey = req.idempotency_key;
    }
    if (req.timeout_ms && req.timeout_ms > 0) {
      options.timeout = req.timeout_ms;
    }
    if (req.identity) {
      options.identity = req.identity;
    }
    return { method, options };
  }

  private async dispatch(
    provider: string,
    method: string,
    endpoint: string,
    options: RequestOptions,
  ): Promise<NormalizedResponse> {
    const providerClient = this.meridian?.provider(provider as "github");
    if (!providerClient) {
      throw new MeridianError(`Unknown provider: "${provider}"`, "validation", provider, false);
    }
    switch (method) {
      case "POST":
        return providerClient.post(endpoint, options);
      case "PUT":
        return providerClient.put(endpoint, options);
      case "PATCH":
        return providerClient.patch(endpoint, options);
      case "DELETE":
        return providerClient.delete(endpoint, options);
      default:
        return providerClient.get(endpoint, options);
    }
  }

  private async handleCall(
    call: grpc.ServerUnaryCall<CallRequestMsg, unknown>,
    callback: grpc.sendUnaryData<Record<string, unknown>>,
  ): Promise<void> {
    if (!this.isAuthorized(call.metadata)) {
      callback({
        code: this.grpcLib.status.UNAUTHENTICATED,
        details:
          "Unauthorized. Provide the proxy token via metadata 'authorization: Bearer <token>' " +
          "or 'x-proxy-token: <token>'.",
      });
      return;
    }

    const req = call.request;
    const provider = req.provider;
    const endpoint = req.endpoint || "/";
    const { method, options } = this.buildOptions(req);

    // Replay short-circuits before any live call.
    const replayKey = `${provider}:${method}:${endpoint}`;
    if (this.replayFrom && this.replayMap.has(replayKey)) {
      callback(null, recordedToProto(this.replayMap.get(replayKey)));
      return;
    }

    try {
      const response = await this.dispatch(provider, method, endpoint, options);
      this.record(provider, endpoint, method, options.query, response);
      callback(null, normalizedToProto(response));
    } catch (err) {
      callback(null, errorToProto(err, provider));
    }
  }

  private handlePaginate(call: grpc.ServerWritableStream<CallRequestMsg, unknown>): void {
    if (!this.isAuthorized(call.metadata)) {
      call.emit("error", {
        code: this.grpcLib.status.UNAUTHENTICATED,
        details:
          "Unauthorized. Provide the proxy token via metadata 'authorization: Bearer <token>' " +
          "or 'x-proxy-token: <token>'.",
      });
      return;
    }

    const req = call.request;
    const provider = req.provider;
    const endpoint = req.endpoint || "/";
    const { options } = this.buildOptions(req);

    void (async () => {
      try {
        const providerClient = this.meridian?.provider(provider as "github");
        if (!providerClient) {
          call.write(
            errorToProto(
              new MeridianError(`Unknown provider: "${provider}"`, "validation", provider, false),
              provider,
            ),
          );
          call.end();
          return;
        }
        for await (const page of providerClient.paginate(endpoint, options)) {
          call.write(normalizedToProto(page));
        }
      } catch (err) {
        call.write(errorToProto(err, provider));
      } finally {
        call.end();
      }
    })();
  }

  private handleStreamCall(call: grpc.ServerWritableStream<CallRequestMsg, unknown>): void {
    if (!this.isAuthorized(call.metadata)) {
      call.emit("error", {
        code: this.grpcLib.status.UNAUTHENTICATED,
        details:
          "Unauthorized. Provide the proxy token via metadata 'authorization: Bearer <token>' " +
          "or 'x-proxy-token: <token>'.",
      });
      return;
    }

    const req = call.request;
    const provider = req.provider;
    const endpoint = req.endpoint || "/";
    const { options } = this.buildOptions(req);
    // SSE endpoints are POST by convention; the SDK's stream() defaults to POST
    // when method is absent. buildOptions always sets GET, so drop it unless the
    // caller asked for a specific method.
    if (!req.method) {
      delete options.method;
    }

    let index = 0;
    void (async () => {
      try {
        const providerClient = this.meridian?.provider(provider as "github");
        if (!providerClient) {
          call.write({
            index: 0,
            done: true,
            ...errorToProto(
              new MeridianError(`Unknown provider: "${provider}"`, "validation", provider, false),
              provider,
            ),
          });
          return;
        }
        for await (const chunk of providerClient.stream(endpoint, options)) {
          call.write(chunkToProto(chunk, index++));
        }
        // Terminal sentinel: lets clients distinguish a clean finish from a
        // truncated connection.
        call.write({ index, done: true });
      } catch (err) {
        call.write({ index, done: true, ...errorToProto(err, provider) });
      } finally {
        call.end();
      }
    })();
  }

  /** Append a sanitized request/response record to the recording file, if enabled. */
  private record(
    provider: string,
    endpoint: string,
    method: string,
    query: RequestOptions["query"],
    response: unknown,
  ): void {
    if (!this.recordTo) {
      return;
    }
    const entry = {
      ts: new Date().toISOString(),
      provider,
      endpoint,
      method,
      query: sanitizeForRecord(query ?? {}, this.recordRedaction),
      response: sanitizeForRecord(response, this.recordRedaction),
    };
    try {
      appendFileSync(this.recordTo, `${JSON.stringify(entry)}\n`, "utf8");
    } catch {
      // non-fatal: recording failure should not break the response
    }
  }
}
