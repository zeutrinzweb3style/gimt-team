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

export default async function handler(request: any, response: any) {
  if (request.method !== "GET") {
    sendJson(response, 405, { ok: false, error: "Method not allowed" });
    return;
  }
  try {
    const url = new URL(request.url ?? "/", "https://example.com");
    const date = url.searchParams.get("date");
    if (date && !isValidDateKey(date)) {
      sendJson(response, 400, { ok: false, error: "date must be a valid YYYY-MM-DD UTC date" });
      return;
    }
    const rows = await getSupabase().select<ActivityLog>(
      "activity_logs",
      params(eq("action", SUMMARY_ACTION), order("created_at", false), limit(400))
    );
    const seen = new Set<string>();
    const summaries = rows
      .map((row) => {
        const rowDate = typeof row.metadata?.summary_date === "string" ? row.metadata.summary_date : "";
        return { row, rowDate, summary: row.metadata?.summary ?? null };
      })
      .filter((item) => item.rowDate && (!date || item.rowDate === date))
      .filter((item) => {
        if (seen.has(item.rowDate)) return false;
        seen.add(item.rowDate);
        return true;
      })
      .map((item) => ({
        record_id: item.row.id,
        created_at: item.row.created_at,
        ...((item.summary && typeof item.summary === "object") ? item.summary : { date: item.rowDate })
      }));
    sendJson(response, 200, { ok: true, count: summaries.length, summaries });
  } catch (error) {
    sendJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}
