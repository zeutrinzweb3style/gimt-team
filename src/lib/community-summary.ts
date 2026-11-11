import { buildSupportIssueStats, buildSupportTicketInsight, type SupportIssueStat } from "./support-insights.js";
import { listSupportTicketMessages, listSupportTicketsInRange } from "./repository.js";
import type { SupportTicket, SupportTicketMessage, SupabaseRestClient } from "./supabase.js";
import { isValidDateKey } from "./repeated-issue-report.js";

export type CommunityConcern = {
  category: string;
  count: number;
  open_count: number;
  needs_moderator_count: number;
  example: string;
};

export type CommunitySummary = {
  date: string;
  headline: string;
  total_questions: number;
  open_questions: number;
  resolved_questions: number;
  needs_moderator_review: number;
  concerns: CommunityConcern[];
  generated_at: string;
};

function redactSensitiveText(value: string): string {
  return value
    .replace(/(?:seed phrase|recovery phrase|private key|secret phrase|mnemonic)\s*[:=]?\s*(?:[a-z]+\s+){5,}[a-z]*/gi, "[wallet credentials redacted]")
    .replace(/\b0x[a-f0-9]{40,64}\b/gi, "[wallet address redacted]")
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, "[email redacted]")
    .replace(/\b(?:\+?\d[\d ().-]{7,}\d)\b/g, "[phone redacted]")
    .replace(/\s+/g, " ")
    .trim();
}

function shortExample(stat: SupportIssueStat): string {
  return redactSensitiveText(stat.sample_summary || "No example message available.").slice(0, 220);
}

function summarizeConcern(stat: SupportIssueStat): CommunityConcern {
  return {
    category: stat.category,
    count: stat.count,
    open_count: stat.open_count,
    needs_moderator_count: stat.needs_moderator_count,
    example: shortExample(stat)
  };
}

export async function buildCommunitySummary(db: SupabaseRestClient, date: string, generatedAt = new Date()): Promise<CommunitySummary> {
  if (!isValidDateKey(date)) throw new Error("date must be a valid YYYY-MM-DD UTC date");
  const tickets = await listSupportTicketsInRange(db, date, date);
  const messages = await listSupportTicketMessages(db, tickets.map((ticket) => ticket.id));
  const messagesByTicket = new Map<string, SupportTicketMessage[]>();
  for (const message of messages) {
    const list = messagesByTicket.get(message.ticket_id) ?? [];
    list.push(message);
    messagesByTicket.set(message.ticket_id, list);
  }
  const enrichedTickets = tickets.map((ticket) => ({
    ...ticket,
    insight: buildSupportTicketInsight(ticket, messagesByTicket.get(ticket.id) ?? [])
  }));
  const stats = buildSupportIssueStats(enrichedTickets);
  const concerns = stats
    .filter((stat) => !stat.is_rollup)
    .slice(0, 8)
    .map(summarizeConcern);
  const openQuestions = tickets.filter((ticket) => ["open", "accepted", "pending_user_resolution", "pending_follow_up"].includes(ticket.status)).length;
  const resolvedQuestions = tickets.filter((ticket) => ["solved_closed", "closed_by_team"].includes(ticket.status)).length;
  const needsModeratorReview = enrichedTickets.filter((ticket) =>
    ticket.insight.dashboard_status === "Needs Moderator Review" || ticket.insight.dashboard_status === "Escalated to Moderator"
  ).length;
  const topConcern = concerns[0]?.category;
  const headline = tickets.length
    ? `Community concerns focused on ${topConcern || "support questions"}.`
    : "No community support questions were recorded.";
  return {
    date,
    headline,
    total_questions: tickets.length,
    open_questions: openQuestions,
    resolved_questions: resolvedQuestions,
    needs_moderator_review: needsModeratorReview,
    concerns,
    generated_at: generatedAt.toISOString()
  };
}

export function formatCommunitySummaryMessage(summary: CommunitySummary): string {
  const lines = [
    `Community concerns — ${summary.date} UTC`,
    summary.headline,
    `Questions: ${summary.total_questions} · Open: ${summary.open_questions} · Resolved: ${summary.resolved_questions} · Needs moderator: ${summary.needs_moderator_review}`
  ];
  for (const concern of summary.concerns.slice(0, 5)) {
    lines.push(`- ${concern.category}: ${concern.count} question(s)`);
  }
  return lines.join("\n");
}

export type SummaryTicket = SupportTicket & { insight: ReturnType<typeof buildSupportTicketInsight> };
