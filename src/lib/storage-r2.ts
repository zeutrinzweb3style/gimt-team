import { optionalEnv, requireEnv } from "./config.js";
import { fetchWithRetry } from "./http.js";
import { signAwsV4 } from "./sigv4.js";
import type { StorageClient } from "./storage.js";

const R2_REGION = "auto";
const R2_SERVICE = "s3";

function encodeKeyPath(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

/**
 * Cloudflare R2 is S3-compatible. The logical `bucket` namespaces used by the
 * app are mapped to key prefixes inside the single configured R2 bucket, so the
 * same call sites keep working after switching STORAGE_DRIVER=r2.
 */
export function createR2Storage(): StorageClient {
  const accountId = requireEnv("R2_ACCOUNT_ID");
  const bucket = requireEnv("R2_BUCKET");
  const accessKeyId = requireEnv("R2_ACCESS_KEY_ID");
  const secretAccessKey = requireEnv("R2_SECRET_ACCESS_KEY");
  const publicBaseUrl = (optionalEnv("R2_PUBLIC_BASE_URL") || "").replace(/\/$/, "");
  const endpointHost = `${accountId}.r2.cloudflarestorage.com`;

  function objectKey(namespace: string, path: string): string {
    return `${namespace}/${path}`.replace(/^\/+/, "");
  }

  return {
    // R2 buckets are created in the Cloudflare dashboard or via the Cloudflare
    // API, not the S3 endpoint, so this is intentionally a no-op.
    async ensureBucket() {
      return;
    },
    async uploadObject(namespace, path, body, contentType = "application/octet-stream") {
      const key = objectKey(namespace, path);
      const url = `https://${endpointHost}/${bucket}/${encodeKeyPath(key)}`;
      const headers: Record<string, string> = {
        "content-type": contentType || "application/octet-stream"
      };
      const authorization = await signAwsV4({
        method: "PUT",
        url,
        region: R2_REGION,
        service: R2_SERVICE,
        accessKeyId,
        secretAccessKey,
        headers,
        body
      });

      const response = await fetchWithRetry(url, {
        method: "PUT",
        headers: { ...headers, ...authorization },
        body: Buffer.from(body)
      }, { timeoutMs: 20000 });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`R2 upload error ${response.status}: ${errorText}`);
      }
    },
    getPublicObjectUrl(namespace, path) {
      if (!publicBaseUrl) {
        throw new Error("Missing R2_PUBLIC_BASE_URL: set it to the R2 public bucket URL or custom domain.");
      }
      return `${publicBaseUrl}/${encodeKeyPath(objectKey(namespace, path))}`;
    }
  };
}
