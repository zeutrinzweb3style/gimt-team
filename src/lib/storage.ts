import { optionalEnv } from "./config.js";
import { createR2Storage } from "./storage-r2.js";
import { createSupabaseStorage } from "./storage-supabase.js";

/**
 * Backend-agnostic object storage. `bucket` is a logical namespace: the
 * Supabase driver maps it to a real bucket, the R2 driver to a key prefix
 * inside the single configured R2 bucket.
 */
export type StorageClient = {
  ensureBucket(bucket: string, isPublic?: boolean): Promise<void>;
  uploadObject(bucket: string, path: string, body: Uint8Array, contentType?: string | null): Promise<void>;
  getPublicObjectUrl(bucket: string, path: string): string;
};

export type StorageDriver = "supabase" | "r2";

export function getStorageDriver(): StorageDriver {
  return (optionalEnv("STORAGE_DRIVER") || "supabase").trim().toLowerCase() === "r2" ? "r2" : "supabase";
}

export function getStorage(): StorageClient {
  return getStorageDriver() === "r2" ? createR2Storage() : createSupabaseStorage();
}
