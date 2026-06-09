import { createHash, createHmac } from "node:crypto";

export interface SigV4Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service?: string;
  sessionToken?: string;
}

export interface SigV4SignInput {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body?: string;
  credentials: SigV4Credentials;
  /** Override the signing instant — primarily for deterministic tests. */
  date?: Date;
}

export interface SigV4SignedRequest {
  headers: Record<string, string>;
}

const UNRESERVED = /^[A-Za-z0-9\-_.~]$/;

/** AWS's "URI encode" — percent-encodes everything outside the unreserved set. */
function uriEncode(value: string, encodeSlash = true): string {
  let out = "";
  for (const ch of Buffer.from(value, "utf-8")) {
    const c = String.fromCharCode(ch);
    if (UNRESERVED.test(c) || (c === "/" && !encodeSlash)) {
      out += c;
    } else {
      out += `%${ch.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return out;
}

function canonicalUri(pathname: string): string {
  if (!pathname || pathname === "") return "/";
  return pathname
    .split("/")
    .map((segment) => uriEncode(segment, false))
    .join("/");
}

function canonicalQueryString(url: URL): string {
  const params: Array<[string, string]> = [];
  url.searchParams.forEach((value, key) => {
    params.push([key, value]);
  });
  params.sort(([ak, av], [bk, bv]) =>
    ak === bk ? (av < bv ? -1 : av > bv ? 1 : 0) : ak < bk ? -1 : 1,
  );
  return params.map(([k, v]) => `${uriEncode(k)}=${uriEncode(v)}`).join("&");
}

function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf-8").digest("hex");
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf-8").digest();
}

function signingKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
  service: string,
): Buffer {
  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

function amzDate(date: Date): { amzDate: string; dateStamp: string } {
  const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

/**
 * Signs a request per AWS Signature Version 4 (the scheme used by S3, R2, and
 * other S3-compatible object stores). Returns the headers to attach — including
 * `Authorization`, `x-amz-date`, `x-amz-content-sha256`, and `host` — that make
 * the request authenticate as the given credentials.
 *
 * Reference: https://docs.aws.amazon.com/general/latest/gr/sigv4-create-canonical-request.html
 */
export function signSigV4(input: SigV4SignInput): SigV4SignedRequest {
  const { method, url, body, credentials } = input;
  const service = credentials.service ?? "s3";
  const date = input.date ?? new Date();
  const { amzDate: amzDateStr, dateStamp } = amzDate(date);

  const payloadHash = sha256Hex(body ?? "");

  const headers: Record<string, string> = {
    ...input.headers,
    host: url.host,
    "x-amz-date": amzDateStr,
    "x-amz-content-sha256": payloadHash,
  };
  if (credentials.sessionToken) {
    headers["x-amz-security-token"] = credentials.sessionToken;
  }

  const headerEntries = Object.entries(headers)
    .map(([k, v]) => [k.toLowerCase(), v.trim().replace(/\s+/g, " ")] as [string, string])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  const canonicalHeaders = headerEntries.map(([k, v]) => `${k}:${v}\n`).join("");
  const signedHeaders = headerEntries.map(([k]) => k).join(";");

  const canonicalRequest = [
    method.toUpperCase(),
    canonicalUri(url.pathname),
    canonicalQueryString(url),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const credentialScope = `${dateStamp}/${credentials.region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDateStr,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const key = signingKey(credentials.secretAccessKey, dateStamp, credentials.region, service);
  const signature = createHmac("sha256", key).update(stringToSign, "utf-8").digest("hex");

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    headers: {
      ...headers,
      Authorization: authorization,
    },
  };
}
