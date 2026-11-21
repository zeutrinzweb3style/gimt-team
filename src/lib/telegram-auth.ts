import { optionalEnv } from "./config.js";

// Telegram Mini App login. The dashboard sends Telegram.WebApp.initData, which
// we verify with the bot token, then hand back a signed session cookie. This is
// identity only: it proves which registered member is looking at the dashboard.

const encoder = new TextEncoder();

/** How long a login is accepted before the member must open the Mini App again. */
const MAX_AUTH_AGE_SECONDS = 60 * 60;

/** How long the signed session cookie stays valid. */
export const SESSION_TTL_SECONDS = 60 * 60 * 12;

export const SESSION_COOKIE = "gimt_session";

export type TelegramWebAppUser = {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  is_premium?: boolean;
};

export type VerifiedInitData = {
  user: TelegramWebAppUser;
  authDate: number;
};

export type Session = {
  /** Absent for Google sign-in, which has no Telegram identity. */
  telegramUserId?: number;
  memberId: string;
  memberName: string;
  provider?: "telegram" | "google";
  exp: number;
};

function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

async function hmacSha256(key: BufferSource, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(data));
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Verifies Telegram.WebApp.initData per
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-web-app
 *
 * secret_key = HMAC_SHA256(bot_token, "WebAppData")
 * hash == hex(HMAC_SHA256(data_check_string, secret_key))
 *
 * The data-check-string is every field except `hash`, sorted by name, joined
 * with newlines. `signature` stays in the string: Telegram includes it in the
 * hash, so dropping it would break verification for clients that send it.
 */
export async function verifyInitData(initData: string, botToken: string, now = new Date()): Promise<VerifiedInitData | null> {
  if (!initData) return null;

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;

  const dataCheckString = [...params.entries()]
    .filter(([key]) => key !== "hash")
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join("\n");

  const secretKey = await hmacSha256(encoder.encode("WebAppData"), botToken);
  const computed = toHex(await hmacSha256(secretKey, dataCheckString));
  if (!constantTimeEqual(computed, hash)) return null;

  const authDate = Number(params.get("auth_date"));
  if (!Number.isFinite(authDate)) return null;
  if (now.getTime() / 1000 - authDate > MAX_AUTH_AGE_SECONDS) return null;

  const rawUser = params.get("user");
  if (!rawUser) return null;

  let user: TelegramWebAppUser;
  try {
    user = JSON.parse(rawUser) as TelegramWebAppUser;
  } catch {
    return null;
  }
  if (!user || !Number.isSafeInteger(user.id)) return null;

  return { user, authDate };
}

/** Signs `value` as `base64url(payload).base64url(hmac)` for cookie transport. */
export async function signValue(value: string, secret: string): Promise<string> {
  const payload = base64UrlEncode(value);
  const signature = base64UrlEncodeBytes(new Uint8Array(await hmacSha256(encoder.encode(secret), payload)));
  return `${payload}.${signature}`;
}

/** The original value, or null when the signature does not match. */
export async function unsignValue(value: string | undefined, secret: string): Promise<string | null> {
  if (!value) return null;

  const [payload, signature] = value.split(".");
  if (!payload || !signature) return null;

  const expected = base64UrlEncodeBytes(new Uint8Array(await hmacSha256(encoder.encode(secret), payload)));
  if (!constantTimeEqual(expected, signature)) return null;

  try {
    return base64UrlDecode(payload);
  } catch {
    return null;
  }
}

/** The cookie value is `payload.signature`; both parts are base64url encoded. */
export async function createSessionCookie(session: Session, secret: string): Promise<string> {
  return signValue(JSON.stringify(session), secret);
}

export async function readSessionCookie(value: string | undefined, secret: string): Promise<Session | null> {
  const raw = await unsignValue(value, secret);
  if (!raw) return null;

  try {
    const session = JSON.parse(raw) as Session;
    if (!session || typeof session.memberId !== "string" || !session.memberId) return null;
    if (typeof session.memberName !== "string") return null;
    if (session.telegramUserId !== undefined && !Number.isSafeInteger(session.telegramUserId)) return null;
    if (session.provider !== undefined && session.provider !== "telegram" && session.provider !== "google") return null;
    if (!Number.isFinite(session.exp) || session.exp <= Math.floor(Date.now() / 1000)) return null;
    return session;
  } catch {
    return null;
  }
}

/** The session signing secret. Falls back to the bot token so nothing extra is required. */
export function getSessionSecret(): string | undefined {
  return optionalEnv("SESSION_SECRET") || optionalEnv("TELEGRAM_BOT_TOKEN");
}

export function getBotToken(): string | undefined {
  return optionalEnv("TELEGRAM_BOT_TOKEN");
}

function base64UrlEncode(value: string): string {
  return base64UrlEncodeBytes(encoder.encode(value));
}

function base64UrlEncodeBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): string {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
