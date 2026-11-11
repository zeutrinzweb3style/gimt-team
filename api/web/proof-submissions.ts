import { eq, limit, order, params, type ActivityLog, type ProofOfWorkSubmission } from "../../src/lib/supabase.js";
import { getSupabase } from "../../src/lib/supabase.js";

function sendJson(response: any, statusCode: number, payload: unknown) {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(payload));
}

function parseInteger(value: string | null, fallback: number, min: number, max: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function gteParam(field: string, value: string): [string, string] {
  return [field, `gte.${value}`];
}

function lteParam(field: string, value: string): [string, string] {
  return [field, `lte.${value}`];
}

export default async function handler(request: any, response: any) {
  try {
    const url = new URL(request.url ?? "/", "https://example.com");
    const reportType = url.searchParams.get("report_type");
    const memberId = url.searchParams.get("member_id");
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    const submittedFrom = url.searchParams.get("submitted_from");
    const submittedTo = url.searchParams.get("submitted_to");
    const rowLimit = parseInteger(url.searchParams.get("limit"), 100, 1, 500);
    const offset = parseInteger(url.searchParams.get("offset"), 0, 0, 50000);

    const db = getSupabase();
    if (reportType) {
      if (reportType !== "weekly" && reportType !== "monthly") {
        sendJson(response, 400, { ok: false, error: "report_type must be weekly or monthly" });
        return;
      }
      const action = reportType === "weekly" ? "PROOF_OF_WORK_WEEKLY_REPORT" : "PROOF_OF_WORK_MONTHLY_REPORT";
      const rows = await db.select<ActivityLog>("activity_logs", params(eq("action", action), order("created_at", false), limit(1000)));
      const reports = rows.map((row) => ({ id: row.id, generated_at: row.created_at, ...row.metadata }));
      sendJson(response, 200, { ok: true, count: reports.length, reports });
      return;
    }

    const filters: [string, string][] = [["order", "submitted_at_utc.desc,id.desc"], limit(rowLimit), ["offset", String(offset)]];
    if (memberId) filters.push(eq("member_id", memberId));
    if (from) filters.push(gteParam("work_date_utc", from));
    if (to) filters.push(lteParam("work_date_utc", to));
    if (submittedFrom) filters.push(gteParam("submitted_at_utc", submittedFrom));
    if (submittedTo) filters.push(lteParam("submitted_at_utc", submittedTo));

    const rows = await db.select<ProofOfWorkSubmission>("proof_of_work_submissions", params(...filters));

    sendJson(response, 200, { ok: true, count: rows.length, submissions: rows });
  } catch (error) {
    sendJson(response, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}
