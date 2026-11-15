import type { StorageClient } from "./storage.js";

/** Logical bucket for images uploaded into page content. */
export const PAGE_IMAGE_BUCKET = "page-images";

/**
 * Vercel's request body limit is 4.5 MB, and the upload travels as base64
 * (which inflates by ~4/3), so the decoded image is capped well below it.
 */
export const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

export type ImageFormat = { mime: string; extension: string };

/**
 * Sniff the real format from the leading bytes rather than trusting the
 * declared content type, so a renamed script cannot be stored as an image.
 */
export function detectImageFormat(bytes: Uint8Array): ImageFormat | null {
  if (bytes.length < 12) return null;

  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { mime: "image/jpeg", extension: "jpg" };

  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (png.every((byte, index) => bytes[index] === byte)) return { mime: "image/png", extension: "png" };

  const gifHeader = String.fromCharCode(...bytes.slice(0, 6));
  if (gifHeader === "GIF87a" || gifHeader === "GIF89a") return { mime: "image/gif", extension: "gif" };

  const riff = String.fromCharCode(...bytes.slice(0, 4));
  const webp = String.fromCharCode(...bytes.slice(8, 12));
  if (riff === "RIFF" && webp === "WEBP") return { mime: "image/webp", extension: "webp" };

  return null;
}

/** Decode a base64 string (with or without a data-URL prefix) to bytes. */
export function decodeBase64Image(input: string): Uint8Array | null {
  const comma = input.startsWith("data:") ? input.indexOf(",") : -1;
  const raw = comma >= 0 ? input.slice(comma + 1) : input;
  if (!raw || !/^[A-Za-z0-9+/=\s]+$/.test(raw)) return null;
  try {
    return new Uint8Array(Buffer.from(raw, "base64"));
  } catch {
    return null;
  }
}

/**
 * Store an uploaded image and return the block-ready descriptor. The object
 * path is namespaced by member and a random id so two members never collide and
 * a filename from the client cannot escape its prefix.
 */
export async function storePageImage(
  storage: StorageClient,
  input: { bytes: Uint8Array; format: ImageFormat; memberId: string; pageId: string }
): Promise<{ url: string; bucket: string; path: string }> {
  const safeMember = input.memberId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 60) || "member";
  const safePage = input.pageId.replace(/[^A-Za-z0-9-]/g, "").slice(0, 60) || "page";
  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  const path = `${safeMember}/${safePage}/${id}.${input.format.extension}`;

  await storage.uploadObject(PAGE_IMAGE_BUCKET, path, input.bytes, input.format.mime);
  return { url: storage.getPublicObjectUrl(PAGE_IMAGE_BUCKET, path), bucket: PAGE_IMAGE_BUCKET, path };
}
