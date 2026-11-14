import { getCompletedProofWindow, dateKeyInManila, addDays, manilaMidnightUtc, currentMonday } from "./proof-reports.js";
import { formatReportDate } from "./repeated-issue-report.js";
import {
  createActivity,
  createSpamReport,
  getAppSetting,
  listMemberSpamReportsInRange,
  listSpamReportsInRange,
  releaseCronEvent,
  tryRecordCronEvent,
  upsertAppSetting
} from "./repository.js";
import { getStoredTeamGroupChatId, getTeamGroupChatId, sendTeamGroupMessage } from "./group-notifications.js";
import { deleteMessage, sendMessage } from "./telegram.js";
import { utcDateKey } from "./time.js";
import type { Registration, SpamReport, SupabaseRestClient } from "./supabase.js";
import type { TelegramMessage } from "./telegram-types.js";

const SPAM_COMMAND = "/spam";
const MAX_REPORTED_COUNT = 100_000;
const WEEKLY_REPORT_ACTION = "SPAM_WEEKLY_REPORT";
const MONTHLY_REPORT_ACTION = "SPAM_MONTHLY_REPORT";

export type SpamCommand =
  | { kind: "not_spam" }
  | { kind: "invalid"; reason: string }
  | { kind: "report"; count: number };

/** Parses "/spam <count>" (optionally addressed as /spam@Bot) in a message. */
export function parseSpamCommand(text: string): SpamCommand {
  const trimmed = (text ?? "").trim();
  if (!trimmed.startsWith("/")) return { kind: "not_spam" };

  const [rawCommand, rawCount] = trimmed.split(/\s+/);
  const command = (rawCommand ?? "").split("@")[0].toLowerCase();
  if (command !== SPAM_COMMAND) return { kind: "not_spam" };

  const countText = (rawCount ?? "").trim();
  if (!/^\d+$/.test(countText)) {
    return { kind: "invalid", reason: `Use ${SPAM_COMMAND} followed by a number, for example ${SPAM_COMMAND} 5.` };
  }

  const count = Number(countText);
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_REPORTED_COUNT) {
    return { kind: "invalid", reason: `Report a whole number between 1 and ${MAX_REPORTED_COUNT}.` };
  }

  return { kind: "report", count };
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Plain-text ack (no parse mode), so member names need no escaping. */
export function buildSpamAckText(
  memberName: string,
  count: number,
  weekly?: { total: number; window: SpamReportWindow }
): string {
  const lines = [`🧹 ${memberName} reported ${count} removed spam.`];
  if (weekly) {
    lines.push(
      `This week (${formatReportDate(weekly.window.startDate)} – ${formatReportDate(weekly.window.endDate)}): ${weekly.total} total`
    );
  }
  return lines.join("\n");
}

type ActiveAck = { messageId: number; sourceMessageId: number };

function ackSettingKey(chatId: number): string {
  return `spam_ack_active:${chatId}`;
}

function parseActiveAck(raw: string | null): ActiveAck | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { messageId?: unknown; sourceMessageId?: unknown };
    if (typeof parsed.messageId === "number" && Number.isSafeInteger(parsed.messageId)) {
      return {
        messageId: parsed.messageId,
        sourceMessageId: typeof parsed.sourceMessageId === "number" ? parsed.sourceMessageId : 0
      };
    }
  } catch {
    // Legacy or plain value stored before JSON tracking; nothing to delete.
  }
  return null;
}

/**
 * Reads the chat's live ack from app_settings. This always hits the database:
 * a serverless host can route the next message to a different instance, so an
 * in-memory cache would miss an ack another instance just posted and leave it
 * in the group. Mirrors deleteActiveSupportIntro.
 */
async function loadActiveAck(db: SupabaseRestClient, chatId: number): Promise<ActiveAck | null> {
  let raw: string | null = null;
  try {
    raw = await getAppSetting(db, ackSettingKey(chatId));
  } catch (error) {
    console.warn(
      `Could not read active spam ack for chat ${chatId}: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }

  return parseActiveAck(raw);
}

async function storeActiveAck(db: SupabaseRestClient, chatId: number, ack: ActiveAck): Promise<void> {
  try {
    await upsertAppSetting(db, ackSettingKey(chatId), JSON.stringify(ack));
  } catch (error) {
    console.warn(
      `Could not persist active spam ack for chat ${chatId}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

async function clearStoredActiveAck(db: SupabaseRestClient, chatId: number): Promise<void> {
  try {
    await upsertAppSetting(db, ackSettingKey(chatId), "");
  } catch (error) {
    console.warn(
      `Could not clear active spam ack for chat ${chatId}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Deletes the chat's current spam ack. Called for every incoming message so the
 * ack disappears as soon as the next message arrives (from any member), and
 * before posting a new ack so a fresh report replaces the previous one.
 * `incomingMessageId` guards a redelivered update from deleting the ack it just
 * produced. Deletion needs the bot to be a group admin; a failure is logged so
 * the missing admin right is visible.
 */
export async function clearActiveSpamAck(
  db: SupabaseRestClient,
  chatId: number,
  incomingMessageId?: number
): Promise<void> {
  const ack = await loadActiveAck(db, chatId);
  if (!ack) return;
  if (incomingMessageId !== undefined && ack.sourceMessageId === incomingMessageId) return;

  const deleted = await deleteMessage(chatId, ack.messageId);
  if (!deleted) {
    console.warn(
      `Could not delete spam ack ${ack.messageId} in chat ${chatId}. The bot may not be an admin in that group.`
    );
  }
  await clearStoredActiveAck(db, chatId);
}

async function postAck(db: SupabaseRestClient, chatId: number, sourceMessageId: number, text: string): Promise<void> {
  try {
    const sent = await sendMessage(chatId, text);
    await storeActiveAck(db, chatId, { messageId: sent.message_id, sourceMessageId });
  } catch (error) {
    console.error(`Failed to post the spam ack to chat ${chatId}:`, error);
  }
}

/**
 * Deletes the "/spam" command message. In a group this needs the bot to be an
 * admin, and in a DM it removes the member's own message.
 */
async function deleteCommandMessage(chatId: number, messageId: number): Promise<void> {
  const deleted = await deleteMessage(chatId, messageId);
  if (!deleted) {
    console.warn(
      `Could not delete the /spam command ${messageId} in chat ${chatId}. The bot may not be an admin in that group.`
    );
  }
}

function isGroupChat(message: TelegramMessage): boolean {
  return message.chat.type === "group" || message.chat.type === "supergroup";
}

/**
 * The chat where a spam ack is posted. A group report is acknowledged in that
 * group; a DM report is acknowledged in the primary group so the whole team
 * sees it, instead of leaving the ack in the member's private chat.
 */
async function resolveAckChatId(db: SupabaseRestClient, message: TelegramMessage): Promise<number> {
  if (isGroupChat(message)) return message.chat.id;

  let envChatId: number | undefined;
  try {
    envChatId = getTeamGroupChatId();
  } catch (error) {
    console.error("Invalid TEAM_GROUP_CHAT_ID", error);
  }
  if (envChatId !== undefined) return envChatId;

  try {
    const storedChatId = await getStoredTeamGroupChatId();
    if (storedChatId !== undefined) return storedChatId;
  } catch (error) {
    console.error("Could not read the stored team group chat id for a spam ack", error);
  }

  // No primary group is known yet; keep the ack in the DM rather than dropping it.
  return message.chat.id;
}

/**
 * Handles a "/spam <count>" report from a registered member in the primary group
 * or a DM. Stores the report, deletes the command message, and posts an ack that
 * the next message removes. A DM report is acknowledged in the primary group.
 * Returns true when the message was a spam report (valid or not) so the caller
 * stops processing it.
 */
export async function handleSpamCommand(
  db: SupabaseRestClient,
  message: TelegramMessage,
  registration: Registration
): Promise<boolean> {
  const parsed = parseSpamCommand(message.text ?? "");
  if (parsed.kind === "not_spam") return false;

  const sourceChatId = message.chat.id;
  const ackChatId = await resolveAckChatId(db, message);
  await clearActiveSpamAck(db, ackChatId, message.message_id);

  if (parsed.kind === "invalid") {
    await deleteCommandMessage(sourceChatId, message.message_id);
    await postAck(db, ackChatId, message.message_id, parsed.reason);
    return true;
  }

  const now = message.date ? new Date(message.date * 1000) : new Date();
  try {
    await createSpamReport(db, {
      member_id: registration.member_id,
      member_name: registration.member_name,
      telegram_user_id: registration.telegram_user_id,
      telegram_chat_id: sourceChatId,
      reported_count: parsed.count,
      work_date_utc: utcDateKey(now),
      reported_at_utc: now.toISOString()
    });
  } catch (error) {
    console.error("Failed to store spam report", error);
    // Keep the command so the member can retry; the error ack still clears on
    // the next message.
    await postAck(db, ackChatId, message.message_id, "Could not save that spam report. Please try again.");
    return true;
  }

  const weeklyTotal = await getMemberWeeklySpamTotal(db, registration.member_id, now);
  await deleteCommandMessage(sourceChatId, message.message_id);
  await postAck(
    db,
    ackChatId,
    message.message_id,
    buildSpamAckText(registration.member_name, parsed.count, weeklyTotal ?? undefined)
  );
  return true;
}

export type SpamReportWindow = {
  key: string;
  startDate: string;
  endDate: string;
  startUtc: string;
  endUtcExclusive: string;
};

export type SpamReportMemberTotal = {
  member_id: string;
  member_name: string;
  total: number;
  reports: number;
};

export type SpamReportSummary = {
  window: SpamReportWindow;
  total: number;
  member_count: number;
  members: SpamReportMemberTotal[];
};

/** The most recently completed Monday–Sunday week in Asia/Manila. */
export function getCompletedSpamWindow(now = new Date()): SpamReportWindow {
  const window = getCompletedProofWindow("weekly", now);
  return {
    key: window.key,
    startDate: window.startDate,
    endDate: window.endDate,
    startUtc: window.startUtc,
    endUtcExclusive: window.endUtcExclusive
  };
}

/** The most recently completed calendar month in Asia/Manila (the previous month). */
export function getCompletedSpamMonth(now = new Date()): SpamReportWindow {
  const window = getCompletedProofWindow("monthly", now);
  return {
    key: window.key,
    startDate: window.startDate,
    endDate: window.endDate,
    startUtc: window.startUtc,
    endUtcExclusive: window.endUtcExclusive
  };
}

/**
 * The Monday–Sunday Asia/Manila week that contains `now`. Counters reset here:
 * each week has its own window, so a new week starts from zero while the
 * previous week's reports stay in the database for that week's report.
 */
export function getCurrentSpamWindow(now = new Date()): SpamReportWindow {
  const startDate = currentMonday(dateKeyInManila(now));
  const endDate = addDays(startDate, 6);
  return {
    key: `week:${startDate}`,
    startDate,
    endDate,
    startUtc: manilaMidnightUtc(startDate).toISOString(),
    endUtcExclusive: manilaMidnightUtc(addDays(endDate, 1)).toISOString()
  };
}

/** The inclusive UTC bounds of a window, for `reported_at_utc` range queries. */
function windowRange(window: SpamReportWindow): { fromUtcIso: string; toUtcIso: string } {
  return {
    fromUtcIso: window.startUtc,
    toUtcIso: new Date(new Date(window.endUtcExclusive).getTime() - 1).toISOString()
  };
}

/**
 * One member's running total for the week that contains `now`. Returns null when
 * the read fails, so the caller can still post the ack without the total.
 */
async function getMemberWeeklySpamTotal(
  db: SupabaseRestClient,
  memberId: string,
  now = new Date()
): Promise<{ total: number; window: SpamReportWindow } | null> {
  const window = getCurrentSpamWindow(now);
  const { fromUtcIso, toUtcIso } = windowRange(window);
  try {
    const rows = await listMemberSpamReportsInRange(db, memberId, fromUtcIso, toUtcIso);
    return { total: rows.reduce((sum, row) => sum + row.reported_count, 0), window };
  } catch (error) {
    console.warn(
      `Could not read the weekly spam total for ${memberId}: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

export function buildSpamReportSummary(window: SpamReportWindow, rows: SpamReport[]): SpamReportSummary {
  const members = new Map<string, SpamReportMemberTotal>();
  for (const row of rows) {
    const current = members.get(row.member_id) ?? {
      member_id: row.member_id,
      member_name: row.member_name || row.member_id,
      total: 0,
      reports: 0
    };
    current.total += row.reported_count;
    current.reports += 1;
    if (row.member_name) current.member_name = row.member_name;
    members.set(row.member_id, current);
  }

  const sorted = [...members.values()].sort(
    (a, b) => b.total - a.total || a.member_name.localeCompare(b.member_name)
  );

  return {
    window,
    total: rows.reduce((sum, row) => sum + row.reported_count, 0),
    member_count: sorted.length,
    members: sorted
  };
}

function buildSpamReportLines(title: string, emptyText: string, summary: SpamReportSummary): string[] {
  const lines = [
    `🧹 <b>${title}</b>`,
    `${formatReportDate(summary.window.startDate)} – ${formatReportDate(summary.window.endDate)} (Asia/Manila)`
  ];

  if (summary.members.length === 0) {
    lines.push("", emptyText);
    return lines;
  }

  const noun = summary.member_count === 1 ? "member" : "members";
  lines.push(`Total: ${summary.total} removed spam from ${summary.member_count} ${noun}`, "");
  for (const member of summary.members) {
    lines.push(`• ${escapeHtml(member.member_name)} — ${member.total}`);
  }
  return lines;
}

export function formatSpamReportMessage(summary: SpamReportSummary): string {
  return buildSpamReportLines("Weekly Spam Report", "No spam was reported this week.", summary).join("\n");
}

export function formatMonthlySpamReportMessage(summary: SpamReportSummary): string {
  return buildSpamReportLines("Monthly Spam Report", "No spam was reported this month.", summary).join("\n");
}

export type SpamReportResult = {
  success: boolean;
  skipped: boolean;
  code?: string;
  window: SpamReportWindow;
  summary: SpamReportSummary | null;
  record_id: string | null;
};

export type WeeklySpamReportResult = SpamReportResult;

type SpamReportPeriod = "weekly" | "monthly";

/**
 * Posts the completed period's spam totals to the primary group. Deduplicated
 * per period through cron_events, so a retried or duplicated scheduler call is
 * safe.
 */
async function sendSpamReport(
  db: SupabaseRestClient,
  period: SpamReportPeriod,
  now = new Date()
): Promise<SpamReportResult> {
  const window = period === "weekly" ? getCompletedSpamWindow(now) : getCompletedSpamMonth(now);
  const eventKey = `spam-report:${window.key}`;
  const action = period === "weekly" ? WEEKLY_REPORT_ACTION : MONTHLY_REPORT_ACTION;
  const label = period === "weekly" ? "Weekly" : "Monthly";
  const format = period === "weekly" ? formatSpamReportMessage : formatMonthlySpamReportMessage;

  const claimed = await tryRecordCronEvent(db, eventKey, "system", window.endDate, action);
  if (!claimed) {
    return { success: true, skipped: true, window, summary: null, record_id: null };
  }

  try {
    const endInclusive = new Date(new Date(window.endUtcExclusive).getTime() - 1).toISOString();
    const rows = await listSpamReportsInRange(db, window.startUtc, endInclusive);
    const summary = buildSpamReportSummary(window, rows);

    const sent = await sendTeamGroupMessage(format(summary), { parseMode: "HTML" });
    if (!sent) {
      await releaseCronEvent(db, eventKey);
      return { success: false, skipped: false, code: "group_unavailable", window, summary: null, record_id: null };
    }

    const record = await createActivity(db, {
      member_id: "system",
      member_name: "System",
      telegram_user_id: null,
      action,
      message: `${label} spam report ${summary.window.startDate} to ${summary.window.endDate}: ${summary.total} removed spam from ${summary.member_count} members.`,
      metadata: summary as unknown as Record<string, unknown>
    });

    return { success: true, skipped: false, window, summary, record_id: record.id };
  } catch (error) {
    await releaseCronEvent(db, eventKey);
    throw error;
  }
}

/** Posts the completed week's spam totals to the primary group. */
export function sendWeeklySpamReport(db: SupabaseRestClient, now = new Date()): Promise<SpamReportResult> {
  return sendSpamReport(db, "weekly", now);
}

/** Posts the completed month's spam totals to the primary group. */
export function sendMonthlySpamReport(db: SupabaseRestClient, now = new Date()): Promise<SpamReportResult> {
  return sendSpamReport(db, "monthly", now);
}
