import { optionalEnv } from "./config.js";
import { fetchWithRetry } from "./http.js";
import { signValue, unsignValue } from "./telegram-auth.js";

// Google sign-in through Supabase Auth, run entirely on the server.
//
// The browser is sent to Supabase's /auth/v1/authorize with a PKCE challenge,
// Supabase brokers the Google consent screen, and the callback posts the code
// and verifier to /auth/v1/token. Nothing here needs supabase-js, and the Google
// client secret never leaves Supabase. The verified email is then resolved to a
// registered member, so an unknown Google account gets no session.

const AUTHORIZE_PATH = "/auth/v1/authorize";
const PKCE_TOKEN_PATH = "/auth/v1/token?grant_type=pkce";

/** How long a started login may sit at the consent screen before it is stale. */
const PENDING_TTL_SECONDS = 600;

/** Holds the PKCE verifier between the redirect out and the callback. */
export const OAUTH_COOKIE = "gimt_oauth";
/** Scoped to the endpoint that reads it, so other paths never receive it. */
export const OAUTH_COOKIE_PATH = "/api/web/members";

export type GoogleIdentity = {
  email: string;
};

export type PendingGoogleLogin = {
  verifier: string;
  next: string;
  exp: number;
};

function supabaseAuthBase(): string | undefined {
  const url = optionalEnv("SUPABASE_URL");
  return url ? url.replace(/\/+$/, "") : undefined;
}

/** The anon key is public by design; the service role key is a fallback so a
 * deployment that only set that one can still sign users in. */
function apiKey(): string | undefined {
  return optionalEnv("SUPABASE_ANON_KEY") || optionalEnv("SUPABASE_SERVICE_ROLE_KEY");
}

export function isGoogleLoginConfigured(): boolean {
  return Boolean(supabaseAuthBase() && apiKey());
}

/**
 * Starts a login: a fresh verifier, its S256 challenge, and the signed cookie
 * that carries the verifier and the post-login destination back to us.
 */
export async function createPendingLogin(
  next: string,
  secret: string
): Promise<{ cookie: string; challenge: string; maxAge: number }> {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = await s256(verifier);
  const exp = Math.floor(Date.now() / 1000) + PENDING_TTL_SECONDS;
  const cookie = await signValue(JSON.stringify({ verifier, next, exp } satisfies PendingGoogleLogin), secret);
  return { cookie, challenge, maxAge: PENDING_TTL_SECONDS };
}

export function buildAuthorizeUrl(redirectTo: string, challenge: string): string {
  const base = supabaseAuthBase();
  if (!base) throw new Error("Missing SUPABASE_URL");

  const params = new URLSearchParams({
    provider: "google",
    redirect_to: redirectTo,
    code_challenge: challenge,
    code_challenge_method: "s256"
  });
  return `${base}${AUTHORIZE_PATH}?${params.toString()}`;
}

export async function readPendingLogin(value: string | undefined, secret: string): Promise<PendingGoogleLogin | null> {
  const raw = await unsignValue(value, secret);
  if (!raw) return null;

  try {
    const pending = JSON.parse(raw) as PendingGoogleLogin;
    if (typeof pending?.verifier !== "string" || !pending.verifier) return null;
    if (typeof pending?.next !== "string") return null;
    if (!Number.isFinite(pending.exp) || pending.exp <= Math.floor(Date.now() / 1000)) return null;
    return pending;
  } catch {
    return null;
  }
}

/** Exchanges the callback code for the Supabase user, keeping only a verified email. */
export async function exchangeCodeForGoogleIdentity(code: string, verifier: string): Promise<GoogleIdentity | null> {
  const base = supabaseAuthBase();
  const key = apiKey();
  if (!base || !key || !code || !verifier) return null;

  const response = await fetchWithRetry(`${base}${PKCE_TOKEN_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: key },
    body: JSON.stringify({ auth_code: code, code_verifier: verifier })
  });
  if (!response.ok) return null;

  let payload: any;
  try {
    payload = await response.json();
  } catch {
    return null;
  }

  const user = payload?.user;
  if (!user || typeof user.email !== "string" || !user.email.trim()) return null;

  const provider = user.app_metadata?.provider;
  if (provider && provider !== "google") return null;

  const verified = Boolean(user.email_confirmed_at || user.confirmed_at || user.user_metadata?.email_verified);
  if (!verified) return null;

  return { email: user.email.trim().toLowerCase() };
}

/** A same-site path only: `//evil.com` and friends would be an open redirect. */
export function sanitizeNextPath(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return "/";
  if (value.includes("\\") || /[\u0000-\u001f]/.test(value)) return "/";
  return value;
}

async function s256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64Url(new Uint8Array(digest));
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
