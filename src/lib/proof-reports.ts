import { limit, lte, order, params, gte, type ProofOfWorkSubmission, type SupabaseRestClient } from "./supabase.js";

export type ProofReportType = "weekly" | "monthly";
export type ProofReportWindow = {
  type: ProofReportType;
  key: string;
  startDate: string;
  endDate: string;
  startUtc: string;
  endUtcExclusive: string;
};
export type ProofReportMember = {
  member_id: string;
  member_name: string;
  submissions: number;
  late_submissions: number;
};
export type ProofReportWeek = {
  week_number: number;
  start_date: string;
  end_date: string;
  submissions: number;
  late_submissions: number;
  members: ProofReportMember[];
};
export type ProofReportSummary = {
  report_type: ProofReportType;
  report_key: string;
  timezone: "Asia/Manila";
  period_start: string;
  period_end: string;
  start_utc: string;
  end_utc_exclusive: string;
  generated_at_utc: string;
  total_submissions: number;
  late_submissions: number;
  member_count: number;
  members: ProofReportMember[];
  weeks?: ProofReportWeek[];
};

const MANILA_TZ = "Asia/Manila";
const DAY_MS = 24 * 60 * 60 * 1000;
const PAGE_SIZE = 1000;

function dateKeyInManila(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: MANILA_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function addDays(dateKey: string, days: number): string {
  const [year, month, day] = dateKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

function manilaMidnightUtc(dateKey: string): Date {
  return new Date(`${dateKey}T00:00:00+08:00`);
}

function currentMonday(dateKey: string): string {
  const [year, month, day] = dateKey.split("-").map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const daysSinceMonday = (weekday + 6) % 7;
  return addDays(dateKey, -daysSinceMonday);
}

function hourInManila(value: Date): number {
  const hour = new Intl.DateTimeFormat("en-US", {
    timeZone: MANILA_TZ,
    hour: "2-digit",
    hourCycle: "h23"
  }).formatToParts(value).find((part) => part.type === "hour")?.value;
  return Number(hour ?? 0);
}

export function getCompletedProofWindow(type: ProofReportType, now = new Date()): ProofReportWindow {
  const today = dateKeyInManila(now);
  let startDate: string;
  let endDate: string;
  let key: string;

  if (type === "weekly") {
    const thisMonday = currentMonday(today);
    const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
    // External scheduler runs Sunday at 11 PM Manila; if delayed past midnight,
    // the Monday branch still resolves to the same completed week.
    const reportCurrentWeek = weekday === 0 && hourInManila(now) >= 23;
    startDate = reportCurrentWeek ? thisMonday : addDays(thisMonday, -7);
    endDate = reportCurrentWeek ? addDays(thisMonday, 6) : addDays(thisMonday, -1);
    key = `week:${startDate}`;
  } else {
    const [year, month] = today.split("-").map(Number);
    const thisMonthStart = `${year}-${String(month).padStart(2, "0")}-01`;
    const previousMonthEnd = addDays(thisMonthStart, -1);
    startDate = `${previousMonthEnd.slice(0, 7)}-01`;
    endDate = previousMonthEnd;
    key = `month:${startDate.slice(0, 7)}`;
  }

  const endExclusiveDate = addDays(endDate, 1);
  return {
    type,
    key,
    startDate,
    endDate,
    startUtc: manilaMidnightUtc(startDate).toISOString(),
    endUtcExclusive: manilaMidnightUtc(endExclusiveDate).toISOString()
  };
}

function isLate(row: ProofOfWorkSubmission): boolean {
  return /late|overdue/i.test(row.status ?? "");
}

function summarizeMembers(rows: ProofOfWorkSubmission[]): ProofReportMember[] {
  const members = new Map<string, ProofReportMember>();
  for (const row of rows) {
    const current = members.get(row.member_id) ?? {
      member_id: row.member_id,
      member_name: row.member_name || row.member_id,
      submissions: 0,
      late_submissions: 0
    };
    current.submissions += 1;
    if (isLate(row)) current.late_submissions += 1;
    members.set(row.member_id, current);
  }
  return [...members.values()].sort((a, b) => a.member_name.localeCompare(b.member_name));
}

function weekBuckets(window: ProofReportWindow, rows: ProofOfWorkSubmission[]): ProofReportWeek[] {
  const [year, month, day] = window.startDate.split("-").map(Number);
  const startWeekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  let cursor = addDays(window.startDate, -((startWeekday + 6) % 7));
  const weeks: ProofReportWeek[] = [];
  while (cursor <= window.endDate) {
    const weekEnd = addDays(cursor, 6);
    const startDate = cursor < window.startDate ? window.startDate : cursor;
    const endDate = weekEnd > window.endDate ? window.endDate : weekEnd;
    const weekRows = rows.filter((row) => {
      const submittedDate = dateKeyInManila(row.submitted_at_utc);
      return submittedDate >= startDate && submittedDate <= endDate;
    });
    weeks.push({
      week_number: weeks.length + 1,
      start_date: startDate,
      end_date: endDate,
      submissions: weekRows.length,
      late_submissions: weekRows.filter(isLate).length,
      members: summarizeMembers(weekRows)
    });
    cursor = addDays(cursor, 7);
  }
  return weeks;
}

export async function fetchProofRowsForWindow(
  db: SupabaseRestClient,
  window: ProofReportWindow
): Promise<ProofOfWorkSubmission[]> {
  const rows: ProofOfWorkSubmission[] = [];
  const endInclusive = new Date(new Date(window.endUtcExclusive).getTime() - 1).toISOString();
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await db.select<ProofOfWorkSubmission>(
      "proof_of_work_submissions",
      params(
        gte("submitted_at_utc", window.startUtc),
        lte("submitted_at_utc", endInclusive),
        ["order", "submitted_at_utc.asc,id.asc"],
        limit(PAGE_SIZE),
        ["offset", String(offset)]
      )
    );
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return rows;
}

export function buildProofReportSummary(
  window: ProofReportWindow,
  rows: ProofOfWorkSubmission[],
  generatedAt = new Date()
): ProofReportSummary {
  const members = summarizeMembers(rows);
  const summary: ProofReportSummary = {
    report_type: window.type,
    report_key: window.key,
    timezone: MANILA_TZ,
    period_start: window.startDate,
    period_end: window.endDate,
    start_utc: window.startUtc,
    end_utc_exclusive: window.endUtcExclusive,
    generated_at_utc: generatedAt.toISOString(),
    total_submissions: rows.length,
    late_submissions: rows.filter(isLate).length,
    member_count: members.length,
    members
  };
  if (window.type === "monthly") summary.weeks = weekBuckets(window, rows);
  return summary;
}
