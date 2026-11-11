import { optionalEnv } from "../../src/lib/config.js";
import { buildCommunitySummary, formatCommunitySummaryMessage } from "../../src/lib/community-summary.js";
import { buildDailyReport } from "../../src/lib/daily-report.js";
import { createActivity } from "../../src/lib/repository.js";
import { eq, limit, order, params, type ActivityLog } from "../../src/lib/supabase.js";
import { getSupabase } from "../../src/lib/supabase.js";
import { isValidDateKey } from "../../src/lib/repeated-issue-report.js";

function sendJson(response: any, statusCode: number, payload: Record<string, unknown>) {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(payload));
}

export default async function handler(request: any, response: any) {
  const cronSecret = optionalEnv("CRON_SECRET");
  const authHeader = request.headers.authorization;
  const url = new URL(request.url ?? "/", "https://example.com");

  if (cronSecret && authHeader !== `Bearer ${cronSecret}` && url.searchParams.get("secret") !== cronSecret) {
    sendJson(response, 401, { ok: false, error: "Unauthorized" });
    return;
  }

  try {
    const startedAt = new Date();
    const communityOnly = url.searchParams.get("community") === "1";
    if (communityOnly) {
      const requestedDate = url.searchParams.get("date");
      const reportDate = requestedDate || startedAt.toISOString().slice(0, 10);
      if (!isValidDateKey(reportDate)) {
        sendJson(response, 400, { ok: false, error: "date must be a valid YYYY-MM-DD UTC date" });
        return;
      }
      const db = getSupabase();
      const action = "COMMUNITY_CONCERNS_DAILY_SUMMARY";
      const existing = await db.select<ActivityLog>("activity_logs", params(eq("action", action), order("created_at", false), limit(200)));
      const previous = existing.find((row) => row.metadata?.summary_date === reportDate);
      if (previous) {
        sendJson(response, 200, { ok: true, skipped: true, date: reportDate, summary: previous.metadata?.summary ?? null, record_id: previous.id });
        return;
      }
      const summary = await buildCommunitySummary(db, reportDate, startedAt);
      const record = await createActivity(db, {
        member_id: "system",
        member_name: "System",
        telegram_user_id: null,
        action,
        message: formatCommunitySummaryMessage(summary),
        metadata: { summary_date: reportDate, summary }
      });
      sendJson(response, 200, { ok: true, skipped: false, date: reportDate, summary, record_id: record.id });
      return;
    }
    console.log(`[cron-daily-report] started at ${startedAt.toISOString()}`);
    const db = getSupabase();
    const report = await buildDailyReport(db);
    await createActivity(db, {
      member_id: "system",
      member_name: "System",
      telegram_user_id: null,
      action: "DAILY_REPORT",
      message: report,
      metadata: {}
    });
    console.log("[cron-daily-report] completed");
    sendJson(response, 200, { ok: true, ranAt: startedAt.toISOString(), report });
  } catch (error) {
    console.error(error);
    sendJson(response, 500, { ok: false, error: "Daily report failed" });
  }
}
