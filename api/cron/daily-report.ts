import { optionalEnv } from "../../src/lib/config.js";
import { buildCommunitySummary, formatCommunitySummaryMessage } from "../../src/lib/community-summary.js";
import { buildDailyReport } from "../../src/lib/daily-report.js";
import { buildProofReportSummary, fetchProofRowsForWindow, getCompletedProofWindow, type ProofReportType } from "../../src/lib/proof-reports.js";
import { createActivity, releaseCronEvent, tryRecordCronEvent } from "../../src/lib/repository.js";
import { eq, limit, order, params, type ActivityLog } from "../../src/lib/supabase.js";
import { getSupabase } from "../../src/lib/supabase.js";
import { isValidDateKey } from "../../src/lib/repeated-issue-report.js";

const WEEKLY_PROOF_ACTION = "PROOF_OF_WORK_WEEKLY_REPORT";
const MONTHLY_PROOF_ACTION = "PROOF_OF_WORK_MONTHLY_REPORT";

function sendJson(response: any, statusCode: number, payload: Record<string, unknown>) {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(payload));
}

async function saveProofReport(type: ProofReportType, startedAt: Date) {
  const db = getSupabase();
  const window = getCompletedProofWindow(type, startedAt);
  const eventKey = `proof-report:${window.key}`;
  const action = type === "weekly" ? WEEKLY_PROOF_ACTION : MONTHLY_PROOF_ACTION;
  const claimed = await tryRecordCronEvent(db, eventKey, "system", window.endDate, action);
  if (!claimed) return { skipped: true, period: window, report: null, record_id: null };

  try {
    const rows = await fetchProofRowsForWindow(db, window);
    const summary = buildProofReportSummary(window, rows, startedAt);
    const record = await createActivity(db, {
      member_id: "system",
      member_name: "System",
      telegram_user_id: null,
      action,
      message: `${type === "weekly" ? "Weekly" : "Monthly"} Proof of Work summary: ${summary.period_start} to ${summary.period_end} PHT · ${summary.total_submissions} submissions from ${summary.member_count} members · ${summary.late_submissions} late.`,
      metadata: summary as unknown as Record<string, unknown>
    });
    return { skipped: false, period: window, report: summary, record_id: record.id };
  } catch (error) {
    await releaseCronEvent(db, eventKey);
    throw error;
  }
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
    const requestedProofReport = url.searchParams.get("report");
    if (requestedProofReport !== null) {
      if (requestedProofReport !== "weekly" && requestedProofReport !== "monthly") {
        sendJson(response, 400, { ok: false, error: "report must be weekly or monthly" });
        return;
      }
      const proofReportType = requestedProofReport as ProofReportType;
      const result = await saveProofReport(proofReportType, startedAt);
      sendJson(response, 200, {
        ok: true,
        task: `${proofReportType}-proof-report`,
        skipped: result.skipped,
        period: result.period,
        report: result.report,
        record_id: result.record_id
      });
      return;
    }

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
