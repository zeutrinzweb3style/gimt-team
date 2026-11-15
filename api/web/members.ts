import { TEAM_SCHEDULE } from "../../src/lib/team-schedule.js";
import { findRegistrationByUser, getMemberProfile, listMemberProfiles, listRegistrations } from "../../src/lib/repository.js";
import {
  buildPageTree,
  collectDescendantIds,
  createPage,
  deletePage,
  getPageById,
  getPageByShareToken,
  isValidShareToken,
  listPages,
  sanitizeBlocks,
  updatePage,
  wouldCreateCycle
} from "../../src/lib/pages.js";
import { getSupabase, type PageBlock } from "../../src/lib/supabase.js";
import {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  createSessionCookie,
  getBotToken,
  getSessionSecret,
  readSessionCookie,
  verifyInitData,
  type Session
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

/** The signed session, or null when the request has no valid login. */
async function readSession(request: any): Promise<Session | null> {
  const secret = getSessionSecret();
  if (!secret) return null;
  return readSessionCookie(readCookie(request, SESSION_COOKIE), secret);
}

/**
 * Pages API, hosted here to stay within Vercel Hobby's 12-function limit.
 *
 * Reads of a shared page are public and keyed by the page's unguessable
 * `share_token` (an unlisted link). Everything else — listing the tree, creating,
 * renaming, saving, moving, deleting — requires a valid Telegram login, and only
 * the member who created a page may change or delete it.
 */
async function handlePages(request: any, response: any, url: URL): Promise<void> {
  const action = url.searchParams.get("action") || "list";
  const db = getSupabase();

  // Public: one page by share token. No login required so a shared link opens.
  if (action === "shared") {
    const token = url.searchParams.get("token") || "";
    if (!isValidShareToken(token)) {
      sendJson(response, 400, { ok: false, error: "Invalid share token." });
      return;
    }
    const page = await getPageByShareToken(db, token);
    if (!page) {
      sendJson(response, 404, { ok: false, error: "Page not found." });
      return;
    }
    const all = await listPages(db);
    const breadcrumb = buildBreadcrumb(all, page.id);
    const linkedIds = collectSubpageIds(page.content);
    const linkedPages = all
      .filter((candidate) => linkedIds.has(candidate.id))
      .map((candidate) => ({ id: candidate.id, title: candidate.title }));
    sendJson(response, 200, { ok: true, page, breadcrumb, linkedPages });
    return;
  }

  const session = await readSession(request);
  if (!session) {
    sendJson(response, 401, { ok: false, error: "Sign in with Telegram to view team pages." });
    return;
  }

  if (action === "list") {
    const pages = await listPages(db);
    sendJson(response, 200, { ok: true, tree: buildPageTree(pages), pages });
    return;
  }

  if (action === "get") {
    const id = url.searchParams.get("id") || "";
    const page = await getPageById(db, id);
    if (!page) {
      sendJson(response, 404, { ok: false, error: "Page not found." });
      return;
    }
    sendJson(response, 200, { ok: true, page });
    return;
  }

  if (action === "create") {
    const body = await readJsonBody(request);
    if (!body) {
      sendJson(response, 400, { ok: false, error: "Expected a JSON body." });
      return;
    }
    const parentId = typeof body.parentId === "string" && body.parentId ? body.parentId : null;
    if (parentId) {
      const parent = await getPageById(db, parentId);
      if (!parent) {
        sendJson(response, 404, { ok: false, error: "Parent page not found." });
        return;
      }
    }
    const page = await createPage(db, {
      parentId,
      title: typeof body.title === "string" ? body.title : "",
      content: sanitizeBlocks(body.content),
      memberId: session.memberId,
      memberName: session.memberName
    });
    sendJson(response, 201, { ok: true, page });
    return;
  }

  if (action === "update") {
    const id = url.searchParams.get("id") || "";
    const page = await getPageById(db, id);
    if (!page) {
      sendJson(response, 404, { ok: false, error: "Page not found." });
      return;
    }
    if (page.created_by_member_id !== session.memberId) {
      sendJson(response, 403, { ok: false, error: "Only the member who created this page can edit it." });
      return;
    }
    const body = await readJsonBody(request);
    if (!body) {
      sendJson(response, 400, { ok: false, error: "Expected a JSON body." });
      return;
    }

    let parentId: string | null | undefined;
    if (typeof body.parentId === "string" || body.parentId === null) {
      parentId = body.parentId === null || body.parentId === "" ? null : String(body.parentId);
      if (parentId && (await wouldCreateCycle(db, id, parentId))) {
        sendJson(response, 400, { ok: false, error: "A page cannot be moved inside itself." });
        return;
      }
      if (parentId && !(await getPageById(db, parentId))) {
        sendJson(response, 404, { ok: false, error: "Parent page not found." });
        return;
      }
    }

    const updated = await updatePage(db, id, {
      title: typeof body.title === "string" ? body.title : undefined,
      content: body.content === undefined ? undefined : sanitizeBlocks(body.content),
      parentId,
      memberId: session.memberId
    });
    sendJson(response, 200, { ok: true, page: updated });
    return;
  }

  if (action === "delete") {
    const id = url.searchParams.get("id") || "";
    const page = await getPageById(db, id);
    if (!page) {
      sendJson(response, 404, { ok: false, error: "Page not found." });
      return;
    }
    if (page.created_by_member_id !== session.memberId) {
      sendJson(response, 403, { ok: false, error: "Only the member who created this page can delete it." });
      return;
    }
    const all = await listPages(db);
    const removed = collectDescendantIds(all, id);
    await deletePage(db, id);
    sendJson(response, 200, { ok: true, deleted: removed.length });
    return;
  }

  sendJson(response, 400, { ok: false, error: `Unknown pages action: ${action}` });
}

/** The chain of ancestors for a page, outermost first, for a shared-page header. */
function buildBreadcrumb(pages: { id: string; parent_id: string | null; title: string }[], pageId: string) {
  const byId = new Map(pages.map((page) => [page.id, page]));
  const chain: { id: string; title: string }[] = [];
  let cursor = byId.get(pageId);
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    chain.unshift({ id: cursor.id, title: cursor.title });
    cursor = cursor.parent_id ? byId.get(cursor.parent_id) : undefined;
  }
  return chain;
}

/** Ids referenced by `subpage` blocks anywhere in a page's block tree. */
function collectSubpageIds(blocks: PageBlock[]): Set<string> {
  const ids = new Set<string>();
  const visit = (list: PageBlock[]) => {
    for (const block of list) {
      if (block.type === "subpage" && block.pageId) ids.add(block.pageId);
      if (block.children?.length) visit(block.children);
    }
  };
  visit(blocks);
  return ids;
}

// Profile lookup lives here (rather than its own function) to stay within the
// Vercel Hobby plan limit of 12 serverless functions.
export default async function handler(request: any, response: any) {
  try {
    const url = new URL(request.url ?? "/", "https://example.com");

    if (url.searchParams.get("resource") === "pages") {
      await handlePages(request, response, url);
      return;
    }

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
