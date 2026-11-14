import { getCompletedProofWindow } from "./proof-reports.js";
import { formatReportDate } from "./repeated-issue-report.js";
import {
  createActivity,
  createSpamReport,
  getAppSetting,
  listSpamReportsInRange,
  releaseCronEvent,
  tryRecordCronEvent,
  upsertAppSetting
} from "./repository.js";
import { sendTeamGroupMessage } from "./group-notifications.js";
import { deleteMessage, sendMessage } from "./telegram.js";
import { utcDateKey } from "./time.js";
import type { Registration, SpamReport, SupabaseRestClient } from "./supabase.js";
import type { TelegramMessage } from "./telegram-types.js";

const SPAM_COMMAND = "/spam";
const MAX_REPORTED_COUNT = 100_000;
const WEEKLY_REPORT_ACTION = "SPAM_WEEKLY_REPORT";

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
export function buildSpamAckText(memberName: string, count: number): string {
  return `🧹 ${memberName} reported ${count} removed spam.`;
}

type ActiveAck = { messageId: number; sourceMessageId: number };

// One active ack per chat, cached for the life of the instance so the common
// "delete the ack when the next message arrives" path costs no database read.
const activeAckCache = new Map<number, ActiveAck | null>();

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

async function loadActiveAck(db: SupabaseRestClient, chatId: number): Promise<ActiveAck | null> {
  if (activeAckCache.has(chatId)) return activeAckCache.get(chatId) ?? null;

  let raw: string | null = null;
  try {
    raw = await getAppSetting(db, ackSettingKey(chatId));
  } catch (error) {
    console.warn(
      `Could not read active spam ack for chat ${chatId}: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }

  const ack = parseActiveAck(raw);
  activeAckCache.set(chatId, ack);
  return ack;
}

async function storeActiveAck(db: SupabaseRestClient, chatId: number, ack: ActiveAck): Promise<void> {
  activeAckCache.set(chatId, ack);
  try {
    await upsertAppSetting(db, ackSettingKey(chatId), JSON.stringify(ack));
  } catch (error) {
    console.warn(
      `Could not persist active spam ack for chat ${chatId}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

async function clearStoredActiveAck(db: SupabaseRestClient, chatId: number): Promise<void> {
  activeAckCache.set(chatId, null);
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
 * ack disappears as soon as the next message arrives, and before posting a new
 * ack so a fresh report replaces the previous one. `incomingMessageId` guards a
 * redelivered update from deleting the ack it just produced.
 */
export async function clearActiveSpamAck(
  db: SupabaseRestClient,
  chatId: number,
  incomingMessageId?: number
): Promise<void> {
  const ack = await loadActiveAck(db, chatId);
  if (!ack) return;
  if (incomingMessageId !== undefined && ack.sourceMessageId === incomingMessageId) return;

  await deleteMessage(chatId, ack.messageId);
  await clearStoredActiveAck(db, chatId);
}

async function postAck(
  db: SupabaseRestClient,
  chatId: number,
  sourceMessageId: number,
  text: string,
  replyToMessageId?: number
): Promise<void> {
  const sent = await sendMessage(chatId, text, replyToMessageId ? { replyToMessageId } : {});
  await storeActiveAck(db, chatId, { messageId: sent.message_id, sourceMessageId });
}

/**
 * Handles a "/spam <count>" report from a registered member in the primary group
 * or a DM. Stores the report, deletes the command message, and posts an ack that
 * the next message in the chat removes. Returns true when the message was a spam
 * report (valid or not) so the caller stops processing it.
 */
export async function handleSpamCommand(
  db: SupabaseRestClient,
  message: TelegramMessage,
  registration: Registration
): Promise<boolean> {
  const parsed = parseSpamCommand(message.text ?? "");
  if (parsed.kind === "not_spam") return false;

  const chatId = message.chat.id;
  await clearActiveSpamAck(db, chatId, message.message_id);

  if (parsed.kind === "invalid") {
    await postAck(db, chatId, message.message_id, parsed.reason, message.message_id);
    return true;
  }

  const now = message.date ? new Date(message.date * 1000) : new Date();
  try {
    await createSpamReport(db, {
      member_id: registration.member_id,
      member_name: registration.member_name,
      telegram_user_id: registration.telegram_user_id,
      telegram_chat_id: chatId,
      reported_count: parsed.count,
      work_date_utc: utcDateKey(now),
      reported_at_utc: now.toISOString()
    });
  } catch (error) {
    console.error("Failed to store spam report", error);
    await postAck(db, chatId, message.message_id, "Could not save that spam report. Please try again.", message.message_id);
    return true;
  }

  // Delete the command itself; in a group this needs the bot to be an admin,
  // and in a DM it removes the member's own message.
  await deleteMessage(chatId, message.message_id);
  await postAck(db, chatId, message.message_id, buildSpamAckText(registration.member_name, parsed.count));
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

export function formatSpamReportMessage(summary: SpamReportSummary): string {
  const lines = [
    "🧹 <b>Weekly Spam Report</b>",
    `${formatReportDate(summary.window.startDate)} – ${formatReportDate(summary.window.endDate)} (Asia/Manila)`
  ];

  if (summary.members.length === 0) {
    lines.push("", "No spam was reported this week.");
    return lines.join("\n");
  }

  const noun = summary.member_count === 1 ? "member" : "members";
  lines.push(`Total: ${summary.total} removed spam from ${summary.member_count} ${noun}`, "");
  for (const member of summary.members) {
    lines.push(`• ${escapeHtml(member.member_name)} — ${member.total}`);
  }
  return lines.join("\n");
}

export type WeeklySpamReportResult = {
  success: boolean;
  skipped: boolean;
  code?: string;
  window: SpamReportWindow;
  summary: SpamReportSummary | null;
  record_id: string | null;
};

/**
 * Posts the completed week's spam totals to the primary group. Deduplicated per
 * week through cron_events, so a retried or duplicated scheduler call is safe.
 */
export async function sendWeeklySpamReport(
  db: SupabaseRestClient,
  now = new Date()
): Promise<WeeklySpamReportResult> {
  const window = getCompletedSpamWindow(now);
  const eventKey = `spam-report:${window.key}`;

  const claimed = await tryRecordCronEvent(db, eventKey, "system", window.endDate, WEEKLY_REPORT_ACTION);
  if (!claimed) {
    return { success: true, skipped: true, window, summary: null, record_id: null };
  }

  try {
    const endInclusive = new Date(new Date(window.endUtcExclusive).getTime() - 1).toISOString();
    const rows = await listSpamReportsInRange(db, window.startUtc, endInclusive);
    const summary = buildSpamReportSummary(window, rows);

    const sent = await sendTeamGroupMessage(formatSpamReportMessage(summary), { parseMode: "HTML" });
    if (!sent) {
      await releaseCronEvent(db, eventKey);
      return { success: false, skipped: false, code: "group_unavailable", window, summary: null, record_id: null };
    }

    const record = await createActivity(db, {
      member_id: "system",
      member_name: "System",
      telegram_user_id: null,
      action: WEEKLY_REPORT_ACTION,
      message: `Weekly spam report ${summary.window.startDate} to ${summary.window.endDate}: ${summary.total} removed spam from ${summary.member_count} members.`,
      metadata: summary as unknown as Record<string, unknown>
    });

    return { success: true, skipped: false, window, summary, record_id: record.id };
  } catch (error) {
    await releaseCronEvent(db, eventKey);
    throw error;
  }
}
