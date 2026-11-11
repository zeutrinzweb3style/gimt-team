import { requireEnv } from "./config.js";
import { fetchWithRetry } from "./http.js";
import type { StorageClient } from "./storage.js";

function getSupabaseKey(): string {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!key) {
    throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY or SUPABASE_ANON_KEY");
  }
  return key;
}

export function createSupabaseStorage(): StorageClient {
  const baseUrl = requireEnv("SUPABASE_URL").replace(/\/$/, "");
  const key = getSupabaseKey();

  async function storageRequest(path: string, init: RequestInit = {}): Promise<void> {
    const response = await fetchWithRetry(`${baseUrl}/storage/v1/${path}`, {
      ...init,
      headers: {
        apikey: key,
        authorization: `Bearer ${key}`,
        ...(init.headers ?? {})
      }
    }, { timeoutMs: 20000 });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Supabase Storage error ${response.status}: ${errorText}`);
    }
  }

  async function ensureBucket(bucket: string, isPublic = true): Promise<void> {
    const response = await fetchWithRetry(`${baseUrl}/storage/v1/bucket`, {
      method: "POST",
      headers: {
        apikey: key,
        authorization: `Bearer ${key}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ id: bucket, name: bucket, public: isPublic })
    }, { timeoutMs: 10000 });

    if (!response.ok) {
      const errorText = await response.text();
      // Treat "already exists" as success so this stays idempotent.
      if (response.status === 409 || /already exists|duplicate/i.test(errorText)) return;
      throw new Error(`Supabase Storage create bucket error ${response.status}: ${errorText}`);
    }
  }

  return {
    ensureBucket,
    async uploadObject(bucket, path, body, contentType = "application/octet-stream") {
      const objectPath = `object/${encodeURIComponent(bucket)}/${path.split("/").map(encodeURIComponent).join("/")}`;
      const upload = () => storageRequest(objectPath, {
        method: "POST",
        headers: {
          "content-type": contentType || "application/octet-stream",
          "cache-control": "3600",
          "x-upsert": "true"
        },
        body: Buffer.from(body)
      });

      try {
        await upload();
      } catch (error) {
        // The bucket may not have been provisioned yet; create it and retry once.
        if (!/bucket not found/i.test(String(error)) && !/\b404\b/.test(String(error))) throw error;
        await ensureBucket(bucket, true);
        await upload();
      }
    },
    getPublicObjectUrl(bucket, path) {
      return `${baseUrl}/storage/v1/object/public/${encodeURIComponent(bucket)}/${path.split("/").map(encodeURIComponent).join("/")}`;
    }
  };
}
