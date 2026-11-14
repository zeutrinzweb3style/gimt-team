import { optionalEnv } from "../../src/lib/config.js";
import { sendWeeklySpamReport } from "../../src/lib/spam-reports.js";
import { getSupabase } from "../../src/lib/supabase.js";

function sendJson(response: any, statusCode: number, payload: Record<string, unknown>) {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(payload));
}

/**
 * Posts the completed week's spam totals to the primary group. Deduplicated per
 * week, so the scheduler may retry or call it more than once safely.
 */
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
    const result = await sendWeeklySpamReport(getSupabase(), startedAt);
    sendJson(response, result.success ? 200 : 503, {
      ok: result.success,
      task: "weekly-spam-report",
      skipped: result.skipped,
      code: result.code,
      period: result.window,
      report: result.summary,
      record_id: result.record_id
    });
  } catch (error) {
    console.error(error);
    sendJson(response, 500, { ok: false, error: "Weekly spam report failed" });
  }
}
