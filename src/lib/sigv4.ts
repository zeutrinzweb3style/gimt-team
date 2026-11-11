// Minimal AWS Signature Version 4 signer for S3-compatible stores (Cloudflare R2).
// Uses WebCrypto so it needs no runtime dependency; Node 20+ exposes crypto.subtle globally.

const encoder = new TextEncoder();

function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? encoder.encode(data) : data;
  return toHex(await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource));
}

async function hmac(key: Uint8Array, data: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key as unknown as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(data)));
}

/** RFC 3986 encoding (stricter than encodeURIComponent for a few sub-delims). */
function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function formatAmzDate(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

export type SignAwsV4Options = {
  method: string;
  url: string;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  headers?: Record<string, string>;
  body?: Uint8Array;
  date?: Date;
};

/**
 * Returns the headers (including `authorization`) required to send a signed
 * request. The caller must use the exact same URL, method and body.
 */
export async function signAwsV4(options: SignAwsV4Options): Promise<Record<string, string>> {
  const url = new URL(options.url);
  const body = options.body ?? new Uint8Array();
  const amzDate = formatAmzDate(options.date ?? new Date());
  const dateStamp = amzDate.slice(0, 8);

  const payloadHash = await sha256Hex(body);

  const rawHeaders: Record<string, string> = {
    host: url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    ...(options.headers ?? {})
  };
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(rawHeaders)) {
    headers[name.toLowerCase()] = value.trim();
  }

  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames.map((name) => `${name}:${headers[name]}\n`).join("");
  const signedHeaders = signedHeaderNames.join(";");

  // url.pathname is already percent-encoded by the URL parser, which matches the
  // request path we send, so it is the canonical URI as-is.
  const canonicalUri = url.pathname || "/";
  const canonicalQuery = [...url.searchParams.keys()]
    .sort()
    .map((key) => `${encodeRfc3986(key)}=${encodeRfc3986(url.searchParams.get(key) ?? "")}`)
    .join("&");

  const canonicalRequest = [
    options.method.toUpperCase(),
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join("\n");

  const credentialScope = `${dateStamp}/${options.region}/${options.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, await sha256Hex(canonicalRequest)].join("\n");

  const kDate = await hmac(encoder.encode(`AWS4${options.secretAccessKey}`), dateStamp);
  const kRegion = await hmac(kDate, options.region);
  const kService = await hmac(kRegion, options.service);
  const kSigning = await hmac(kService, "aws4_request");
  const signature = toHex((await hmac(kSigning, stringToSign)).buffer as ArrayBuffer);

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${options.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return { ...headers, authorization };
}
