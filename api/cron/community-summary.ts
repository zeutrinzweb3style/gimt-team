import { optionalEnv } from "../../src/lib/config.js";
import { buildCommunitySummary, formatCommunitySummaryMessage } from "../../src/lib/community-summary.js";
import { createActivity } from "../../src/lib/repository.js";
import { eq, limit, order, params, type ActivityLog } from "../../src/lib/supabase.js";
import { getSupabase } from "../../src/lib/supabase.js";
import { isValidDateKey } from "../../src/lib/repeated-issue-report.js";

const SUMMARY_ACTION = "COMMUNITY_CONCERNS_DAILY_SUMMARY";

function sendJson(response: any, statusCode: number, payload: unknown) {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(payload));
}

function isAuthorized(request: any): boolean {
  const secret = optionalEnv("CRON_SECRET");
  if (!secret) return true;
  const url = new URL(request.url ?? "/", "https://example.com");
  return request.headers?.authorization === `Bearer ${secret}` || url.searchParams.get("secret") === secret;
}

function summaryDate(request: any): string {
  const url = new URL(request.url ?? "/", "https://example.com");
  const requested = url.searchParams.get("date");
  if (requested) return requested;
  return new Date().toISOString().slice(0, 10);
}

export default async function handler(request: any, response: any) {
  if (request.method !== "GET") {
    sendJson(response, 405, { ok: false, error: "Method not allowed" });
    return;
  }
  if (!isAuthorized(request)) {
    sendJson(response, 401, { ok: false, error: "Unauthorized" });
    return;
  }
  const date = summaryDate(request);
  if (!isValidDateKey(date)) {
    sendJson(response, 400, { ok: false, error: "date must be a valid YYYY-MM-DD UTC date" });
    return;
  }
  try {
    const db = getSupabase();
    const existing = await db.select<ActivityLog>(
      "activity_logs",
      params(eq("action", SUMMARY_ACTION), order("created_at", false), limit(200))
    );
    const previous = existing.find((row) => row.metadata?.summary_date === date);
    if (previous) {
      sendJson(response, 200, { ok: true, skipped: true, date, summary: previous.metadata?.summary ?? null, record_id: previous.id });
      return;
    }
    const summary = await buildCommunitySummary(db, date);
    const record = await createActivity(db, {
      member_id: "system",
      member_name: "System",
      telegram_user_id: null,
      action: SUMMARY_ACTION,
      message: formatCommunitySummaryMessage(summary),
      metadata: { summary_date: date, summary }
    });
    sendJson(response, 200, { ok: true, skipped: false, date, summary, record_id: record.id });
  } catch (error) {
    console.error(error);
    sendJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}
