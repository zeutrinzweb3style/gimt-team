import { TEAM_SCHEDULE } from "../../src/lib/team-schedule.js";
import { findRegistrationByUser, getMemberProfile, listMemberProfiles, listRegistrations } from "../../src/lib/repository.js";
import { getSupabase } from "../../src/lib/supabase.js";
import {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  createSessionCookie,
  getBotToken,
  getSessionSecret,
  readSessionCookie,
  verifyInitData
} from "../../src/lib/telegram-auth.js";

function sendJson(response: any, statusCode: number, payload: unknown) {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(payload));
}

function readCookie(request: any, name: string): string | undefined {
  const header = request.headers?.cookie ?? request.headers?.Cookie ?? "";
  for (const part of String(header).split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

function setSessionCookie(response: any, value: string, maxAge: number) {
  const parts = [`${SESSION_COOKIE}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAge}`];
  const isHttpsHost = Boolean(process.env.VERCEL || process.env.NETLIFY) || process.env.NODE_ENV === "production";
  if (isHttpsHost) parts.push("Secure");
  response.setHeader("set-cookie", parts.join("; "));
}

async function readJsonBody(request: any): Promise<Record<string, unknown> | null> {
  if (request.body && typeof request.body === "object") return request.body as Record<string, unknown>;

  let raw = typeof request.body === "string" ? request.body : "";
  if (!raw && request[Symbol.asyncIterator]) {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    raw = Buffer.concat(chunks).toString("utf8");
  }
  if (!raw) return null;

  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Identity-only Telegram login: verifies initData and sets a signed session cookie. */
async function handleAuth(request: any, response: any, mode: string): Promise<boolean> {
  const secret = getSessionSecret();

  if (mode === "logout") {
    setSessionCookie(response, "", 0);
    sendJson(response, 200, { ok: true, connected: null });
    return true;
  }

  if (mode === "me") {
    const session = secret ? await readSessionCookie(readCookie(request, SESSION_COOKIE), secret) : null;
    sendJson(response, 200, {
      ok: true,
      connected: session ? { member_id: session.memberId, member_name: session.memberName } : null
    });
    return true;
  }

  if (mode === "login") {
    const botToken = getBotToken();
    if (!botToken || !secret) {
      sendJson(response, 503, { ok: false, error: "Login is not configured (missing TELEGRAM_BOT_TOKEN)." });
      return true;
    }

    const body = await readJsonBody(request);
    const initData = typeof body?.initData === "string" ? body.initData : "";
    const verified = await verifyInitData(initData, botToken);
    if (!verified) {
      sendJson(response, 401, { ok: false, error: "Telegram login could not be verified. Open the dashboard from the bot." });
      return true;
    }

    const registration = await findRegistrationByUser(getSupabase(), verified.user.id);
    if (!registration) {
      sendJson(response, 403, { ok: false, error: "This Telegram account is not a registered team member." });
      return true;
    }

    const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
    const cookie = await createSessionCookie(
      {
        telegramUserId: verified.user.id,
        memberId: registration.member_id,
        memberName: registration.member_name,
        exp
      },
      secret
    );
    setSessionCookie(response, cookie, SESSION_TTL_SECONDS);
    sendJson(response, 200, { ok: true, connected: { member_id: registration.member_id, member_name: registration.member_name } });
    return true;
  }

  return false;
}

// Profile lookup lives here (rather than its own function) to stay within the
// Vercel Hobby plan limit of 12 serverless functions.
export default async function handler(request: any, response: any) {
  try {
    const url = new URL(request.url ?? "/", "https://example.com");

    const authMode = url.searchParams.get("auth");
    if (authMode === "me" || authMode === "logout" || authMode === "login") {
      if (await handleAuth(request, response, authMode)) return;
    }

    const memberId = url.searchParams.get("member_id");
    const db = getSupabase();

    if (memberId) {
      const profile = await getMemberProfile(db, memberId);
      sendJson(response, 200, { ok: true, profile });
      return;
    }

    const [registrations, profiles] = await Promise.all([
      listRegistrations(db),
      listMemberProfiles(db).catch(() => [])
    ]);
    const registrationByMember = new Map(registrations.map((r) => [r.member_id, r]));
    const profileByMember = new Map(profiles.map((p) => [p.member_id, p]));

    const members = TEAM_SCHEDULE.map((member) => {
      const registration = registrationByMember.get(member.id);
      const profile = profileByMember.get(member.id);
      return {
        id: member.id,
        name: member.name,
        timezone: member.timezone,
        shift_start_utc: member.shiftStartUtc,
        shift_end_utc: member.shiftEndUtc,
        registered: Boolean(registration),
        telegram_username: registration?.telegram_username ?? null,
        telegram_user_id: registration?.telegram_user_id ?? null,
        headline: profile?.headline ?? null,
        avatar_url: profile?.avatar?.url ?? null,
        link_count: Array.isArray(profile?.links) ? profile.links.length : 0,
        has_profile: Boolean(profile)
      };
    });

    sendJson(response, 200, { ok: true, members });
  } catch (error) {
    sendJson(response, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}
