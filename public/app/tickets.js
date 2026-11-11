import { buildIssueReportHref } from "./issue-report.js";
import { TICKET_STATUS_LABEL, TICKET_STATUS_PILL, state } from "./state.js";
import { $, $all, escapeHtml, fetchJson, fmtRelative, fmtTimeUtc, pill, safeImageUrl, ticketMessageDisplayText } from "./utils.js";

export function renderTicketsGroupFilter(groups) {
  const select = $("#tickets-group-filter");
  const current = state.tickets.filters.telegram_chat_id;
  select.innerHTML = '<option value="">All groups</option>' + groups
    .map((group) => `<option value="${escapeHtml(group.telegram_chat_id)}">${escapeHtml(group.display_name || group.title || `Chat ${group.telegram_chat_id}`)}</option>`)
    .join("");
  if (current && groups.some((group) => String(group.telegram_chat_id) === current)) {
    select.value = current;
  } else if (current) {
    select.innerHTML += `<option value="${escapeHtml(current)}">Chat ${escapeHtml(current)}</option>`;
    select.value = current;
  } else {
    select.value = "";
  }
}

export function ticketDisplayCode(row) {
  return row.ticket_code || String(row.id || "").slice(0, 8) || "—";
}

export function ticketGroupName(row) {
  return row.group_title || (row.telegram_chat_id ? `Chat ${row.telegram_chat_id}` : "—");
}

export function renderTicketMessageAttachments(message) {
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  const photos = attachments.filter((attachment) => attachment && attachment.type === "photo" && safeImageUrl(attachment.url));
  if (!photos.length) return "";

  return `
    <div class="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2">
      ${photos.map((attachment, index) => {
        const imageUrl = safeImageUrl(attachment.url);
        return `
          <a href="${escapeHtml(imageUrl)}" target="_blank" rel="noopener noreferrer" class="block rounded-md border border-slate-200 dark:border-slate-700 overflow-hidden bg-slate-50 dark:bg-slate-900">
            <img src="${escapeHtml(imageUrl)}" alt="Ticket photo attachment ${index + 1}" loading="lazy" class="max-h-64 w-full object-contain bg-slate-100 dark:bg-slate-900" />
            <div class="px-2 py-1 text-[11px] text-blue-600 dark:text-blue-300">Open image</div>
          </a>
        `;
      }).join("")}
    </div>
  `;
}

export function renderTicketMessages(row) {
  const messages = row.messages || [];
  if (!messages.length) {
    return '<p class="text-xs text-slate-500 dark:text-slate-400">No message history recorded for this ticket yet.</p>';
  }

  return `
    <div class="space-y-2">
      ${messages.map((message) => `
        <div class="rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2">
          <div class="flex items-center justify-between gap-2 text-[11px] text-slate-500 dark:text-slate-400">
            <span><strong>${escapeHtml(message.sender_name)}</strong> · ${escapeHtml(message.sender_type)}</span>
            <span class="mono whitespace-nowrap">${escapeHtml(fmtTimeUtc(message.message_date_utc))}</span>
          </div>
          <div class="mt-1 text-sm whitespace-pre-wrap break-words">${escapeHtml(ticketMessageDisplayText(message.message_text))}</div>
          ${renderTicketMessageAttachments(message)}
        </div>
      `).join("")}
    </div>
  `;
}

export function renderTicketInsight(row) {
  const insight = row.insight;
  if (!insight) return "";
  const risks = Array.isArray(insight.risk_flags) && insight.risk_flags.length
    ? insight.risk_flags.map((flag) => `<li>${escapeHtml(flag)}</li>`).join("")
    : "<li>No automatic risk flags.</li>";
  const evidence = Array.isArray(insight.evidence_checklist) && insight.evidence_checklist.length
    ? insight.evidence_checklist.map((item) => `<li>${escapeHtml(item)}</li>`).join("")
    : "<li>No checklist available.</li>";

  return `
    <div class="mb-3 grid grid-cols-1 lg:grid-cols-3 gap-3">
      <div class="rounded-lg border border-teal-200 dark:border-teal-900 bg-teal-50 dark:bg-teal-950/30 p-3">
        <div class="text-[11px] font-semibold uppercase tracking-wide text-teal-700 dark:text-teal-300">Conversation summary</div>
        <p class="mt-1 text-sm text-slate-700 dark:text-slate-200 whitespace-pre-wrap">${escapeHtml(insight.summary)}</p>
        <p class="mt-2 text-xs text-slate-500 dark:text-slate-400"><strong>Next action:</strong> ${escapeHtml(insight.next_action)}</p>
      </div>
      <div class="rounded-lg border border-blue-200 dark:border-blue-900 bg-blue-50 dark:bg-blue-950/30 p-3">
        <div class="text-[11px] font-semibold uppercase tracking-wide text-blue-700 dark:text-blue-300">Translation assist</div>
        <p class="mt-1 text-sm text-slate-700 dark:text-slate-200">${escapeHtml(insight.detected_language?.name || "Unknown")} · ${escapeHtml(insight.detected_language?.confidence || "low")} confidence</p>
        <p class="mt-2 text-xs text-slate-500 dark:text-slate-400 whitespace-pre-wrap">${escapeHtml(insight.english_translation_assist)}</p>
      </div>
      <div class="rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/30 p-3">
        <div class="text-[11px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">Review checklist</div>
        <ul class="mt-1 text-xs text-slate-600 dark:text-slate-300 list-disc pl-4 space-y-1">${evidence}</ul>
        <div class="mt-2 text-[11px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">Risk flags</div>
        <ul class="mt-1 text-xs text-slate-600 dark:text-slate-300 list-disc pl-4 space-y-1">${risks}</ul>
      </div>
    </div>
  `;
}

export function renderIssueStats(targetSelector, stats) {
  const target = $(targetSelector);
  if (!target) return;
  const topStats = (stats || []).slice(0, 5);
  if (!topStats.length) {
    target.innerHTML = '<p class="text-xs text-slate-500 dark:text-slate-400">No repeated issue data in this view yet.</p>';
    return;
  }

  target.innerHTML = topStats.map((stat) => {
    const period = stat.period_from
      ? `${fmtReportDate(stat.period_from)} to ${fmtReportDate(stat.period_to || stat.period_from)}`
      : "No report period yet";
    const daily = Array.isArray(stat.daily_counts) ? stat.daily_counts : [];
    const dailyTotal = daily.reduce((sum, day) => sum + Number(day.count || 0), 0);
    const dailySummary = dailyTotal
      ? daily.filter((day) => Number(day.count) > 0).map((day) => `${day.date}: ${day.count}`).join(" · ")
      : "No daily breakdown available";
    const includes = Array.isArray(stat.includes) && stat.includes.length
      ? `<div class="mt-1 text-[11px] text-slate-400">Includes: ${escapeHtml(stat.includes.join(", "))}</div>`
      : "";
    // Each card opens that issue's own report URL (?issue=...&from=...&to=...),
    // seeded with the period this category was reported over.
    const from = stat.period_from || "";
    const to = stat.period_to || stat.period_from || "";
    const reportHref = buildIssueReportHref(stat.category, from, to);
    return `
      <div class="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-3 shadow-sm issue-stat-card"
           role="button" tabindex="0"
           data-issue-category="${escapeHtml(stat.category)}"
           data-issue-from="${escapeHtml(from)}"
           data-issue-to="${escapeHtml(to)}"
           aria-label="Open the ${escapeHtml(stat.category)} report from ${escapeHtml(period)}">
        <div class="flex items-start justify-between gap-3">
          <div>
            <div class="text-sm font-semibold text-slate-800 dark:text-slate-100">${escapeHtml(stat.category)}</div>
            ${includes}
            <div class="mt-1 text-xs text-slate-500 dark:text-slate-400">Report date: ${escapeHtml(period)}</div>
            <div class="mt-1 text-[11px] text-slate-400">Latest: ${escapeHtml(fmtTimeUtc(stat.latest_at))}${stat.sample_ticket_code ? ` · #${escapeHtml(stat.sample_ticket_code)}` : ""}</div>
          </div>
          <div class="text-right">
            <div class="text-lg font-bold text-teal-700 dark:text-teal-300">${escapeHtml(stat.count)}</div>
            <div class="text-[10px] uppercase tracking-wide text-slate-400">total reports</div>
          </div>
        </div>
        <div class="mt-2 text-xs text-slate-600 dark:text-slate-300">Open: ${escapeHtml(stat.open_count)} · Needs moderator: ${escapeHtml(stat.needs_moderator_count)} · Closed: ${escapeHtml(stat.closed_count || 0)}</div>
        <div class="mt-2 text-xs text-slate-500 dark:text-slate-400"><strong>Daily:</strong> <span class="whitespace-pre-wrap">${escapeHtml(dailySummary)}</span></div>
        <div class="mt-2 text-xs text-slate-500 dark:text-slate-400 whitespace-pre-wrap">${escapeHtml(stat.sample_summary)}</div>
        <div class="mt-2 flex items-center justify-between gap-2">
          <span class="issue-stat-open">View report &rarr;</span>
          <a href="${escapeHtml(reportHref)}" target="_blank" rel="noopener" class="text-[11px] text-slate-400 hover:underline" data-issue-link="1">Open in new tab</a>
        </div>
      </div>
    `;
  }).join("");
}

export function fmtReportDate(dateKey) {
  if (!dateKey) return "—";
  const parsed = new Date(`${String(dateKey).slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return String(dateKey);
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", year: "numeric", month: "long", day: "numeric" }).format(parsed);
}

// Compact form for the per-day grid, e.g. "Sep 1".
export function fmtReportDateShort(dateKey) {
  if (!dateKey) return "—";
  const parsed = new Date(`${String(dateKey).slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return String(dateKey);
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" }).format(parsed);
}

export function renderIssueReportSummary(selector, report) {
  const el = $(selector);
  if (!el) return;
  if (!report) {
    el.textContent = "";
    return;
  }
  el.textContent = `Report period: ${fmtReportDate(report.range_from)} to ${fmtReportDate(report.range_to)} · ` +
    `${report.total_tickets} ticket${report.total_tickets === 1 ? "" : "s"} in period · ${report.today_total} today`;
}

export function renderTicketRow(row, source = "tickets") {
  const status = pill(TICKET_STATUS_PILL[row.status] || "pill-slate", TICKET_STATUS_LABEL[row.status] || row.status);
  const assigned = row.assigned_member_name || "—";
  const scheduled = row.scheduled_member_name || "—";
  const isExpanded = state[source]?.expandedIds?.has(row.id);
  const messageCount = (row.messages || []).length;
  const code = ticketDisplayCode(row);
  return `
    <tr>
      <td class="mono ticket-cell-nowrap">
        <div class="font-semibold">#${escapeHtml(code)}</div>
        <button type="button" class="ticket-history-toggle text-xs text-blue-600 dark:text-blue-300 hover:underline" data-ticket-id="${escapeHtml(row.id)}" data-ticket-source="${escapeHtml(source)}">
          ${isExpanded ? "Hide" : "View"} history (${messageCount})
        </button>
      </td>
      <td class="mono ticket-cell-nowrap">
        <div>${escapeHtml(fmtTimeUtc(row.created_at))}</div>
        <div class="text-[10px] text-slate-400">${escapeHtml(fmtRelative(row.created_at))}</div>
      </td>
      <td>
        <div class="font-medium">${escapeHtml(ticketGroupName(row))}</div>
        ${row.telegram_chat_id ? `<div class="text-[10px] text-slate-400 mono">${escapeHtml(row.telegram_chat_id)}</div>` : ""}
      </td>
      <td>
        <div class="font-medium">${escapeHtml(row.opened_by_name)}</div>
        <div class="text-xs text-slate-500 dark:text-slate-400 whitespace-pre-wrap break-words">${escapeHtml(row.opened_message_text)}</div>
        <div class="mt-1 text-[11px] text-slate-400">Conversation is hidden until you click View history.</div>
      </td>
      <td>${status}</td>
      <td>${escapeHtml(scheduled)}</td>
      <td>${escapeHtml(assigned)}</td>
      <td class="mono ticket-cell-nowrap">${escapeHtml(fmtTimeUtc(row.closed_at))}</td>
    </tr>
    ${isExpanded ? `
      <tr>
        <td colspan="8" class="bg-slate-50 dark:bg-slate-950">
          ${renderTicketInsight(row)}
          <div class="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-2">Chat history for #${escapeHtml(code)}</div>
          ${renderTicketMessages(row)}
        </td>
      </tr>
    ` : ""}
  `;
}

export function updateTicketQueueButtons() {
  for (const button of $all(".ticket-queue-btn")) {
    const status = button.dataset.ticketStatus || "";
    const isActive = state.tickets.filters.status === status;
    button.classList.toggle("bg-teal-600", isActive);
    button.classList.toggle("text-white", isActive);
    button.classList.toggle("border-teal-600", isActive);
    button.classList.toggle("bg-white", !isActive);
    button.classList.toggle("dark:bg-slate-900", !isActive);
  }
}

export function renderTickets() {
  const tbody = $("#tickets-body");
  const rows = state.tickets.rows;
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="text-center text-sm text-slate-500 dark:text-slate-400 py-4">No support tickets in this view.</td></tr>';
  } else {
    tbody.innerHTML = rows.map((row) => renderTicketRow(row, "tickets")).join("");
  }
  updateTicketQueueButtons();
  const activeCount = rows.filter((row) => row.status === "open" || row.status === "accepted").length;
  const closedCount = rows.filter((row) => row.closed_at || row.status === "expired" || String(row.status || "").endsWith("_closed")).length;
  const messageCount = rows.reduce((sum, row) => sum + (row.messages || []).length, 0);
  renderIssueStats("#tickets-issue-stats", state.tickets.issueStats);
  renderIssueReportSummary("#tickets-issue-report", state.tickets.issueReport);
  const selectedGroup = state.tickets.filters.telegram_chat_id
    ? state.tickets.groups.find((group) => String(group.telegram_chat_id) === state.tickets.filters.telegram_chat_id)
    : null;
  const groupLabel = selectedGroup
    ? selectedGroup.display_name || selectedGroup.title || selectedGroup.telegram_chat_id
    : state.tickets.filters.telegram_chat_id
      ? `Chat ${state.tickets.filters.telegram_chat_id}`
      : "All groups";
  $("#tickets-count").textContent = `${rows.length} ticket${rows.length === 1 ? "" : "s"} · ${groupLabel} · ${messageCount} logged message${messageCount === 1 ? "" : "s"} · ${activeCount} active · ${closedCount} closed`;
}

export function renderTicketSearch() {
  const tbody = $("#ticket-search-body");
  const rows = state.ticketSearch.rows;
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="text-center text-sm text-slate-500 dark:text-slate-400 py-4">No tickets match this search.</td></tr>';
  } else {
    tbody.innerHTML = rows.map((row) => renderTicketRow(row, "ticketSearch")).join("");
  }
  const messageCount = rows.reduce((sum, row) => sum + (row.messages || []).length, 0);
  renderIssueStats("#ticket-search-issue-stats", state.ticketSearch.issueStats);
  renderIssueReportSummary("#ticket-search-issue-report", state.ticketSearch.issueReport);
  const activeFilters = [
    state.ticketSearch.filters.q ? `search: “${state.ticketSearch.filters.q}”` : "",
    state.ticketSearch.filters.member_id ? "team member selected" : "",
    state.ticketSearch.filters.status ? (TICKET_STATUS_LABEL[state.ticketSearch.filters.status] || state.ticketSearch.filters.status) : ""
  ].filter(Boolean).join(" · ") || "latest tickets";
  $("#ticket-search-count").textContent = `${rows.length} ticket${rows.length === 1 ? "" : "s"} found · ${messageCount} logged message${messageCount === 1 ? "" : "s"} · ${activeFilters}`;
}

export async function loadTicketSearch() {
  const qs = new URLSearchParams({ limit: "1000" });
  const { q, member_id, status } = state.ticketSearch.filters;
  if (q) qs.set("q", q);
  if (member_id) qs.set("member_id", member_id);
  if (status) qs.set("status", status);

  $("#ticket-search-body").innerHTML = '<tr><td colspan="8" class="text-center text-sm text-slate-500 dark:text-slate-400 py-4">Searching…</td></tr>';
  try {
    const data = await fetchJson(`/api/web/support-tickets?${qs.toString()}`);
    state.ticketSearch.rows = data.tickets;
    state.ticketSearch.issueStats = data.issue_stats || [];
    state.ticketSearch.issueReport = data.issue_reports || null;
    renderTicketSearch();
  } catch (error) {
    $("#ticket-search-body").innerHTML = `<tr><td colspan="8" class="text-center text-sm text-red-600 dark:text-red-400 py-4">Failed to search: ${escapeHtml(error.message)}</td></tr>`;
  }
}

export async function loadTickets() {
  const qs = new URLSearchParams({ limit: "500" });
  const { assigned_member_id, scheduled_member_id, status, telegram_chat_id } = state.tickets.filters;
  const from = $("#tickets-from").value;
  const to = $("#tickets-to").value;
  if (assigned_member_id) qs.set("assigned_member_id", assigned_member_id);
  if (scheduled_member_id) qs.set("scheduled_member_id", scheduled_member_id);
  if (status) qs.set("status", status);
  if (telegram_chat_id) qs.set("telegram_chat_id", telegram_chat_id);
  if (from) qs.set("from", from);
  if (to) qs.set("to", to);

  $("#tickets-body").innerHTML = '<tr><td colspan="8" class="text-center text-sm text-slate-500 dark:text-slate-400 py-4">Loading…</td></tr>';
  try {
    const data = await fetchJson(`/api/web/support-tickets?${qs.toString()}`);
    state.tickets.rows = data.tickets;
    state.tickets.issueStats = data.issue_stats || [];
    state.tickets.issueReport = data.issue_reports || null;
    const groupsById = new Map(state.tickets.groups.map((group) => [String(group.telegram_chat_id), group]));
    for (const ticket of data.tickets) {
      if (!ticket.telegram_chat_id) continue;
      const key = String(ticket.telegram_chat_id);
      if (!groupsById.has(key)) {
        groupsById.set(key, {
          telegram_chat_id: ticket.telegram_chat_id,
          title: ticket.group_title || null,
          display_name: ticket.group_title || `Chat ${ticket.telegram_chat_id}`
        });
      }
    }
    state.tickets.groups = Array.from(groupsById.values()).sort((a, b) =>
      String(a.display_name || a.title || a.telegram_chat_id).localeCompare(String(b.display_name || b.title || b.telegram_chat_id))
    );
    renderTicketsGroupFilter(state.tickets.groups);
    renderTickets();
  } catch (error) {
    $("#tickets-body").innerHTML = `<tr><td colspan="8" class="text-center text-sm text-red-600 dark:text-red-400 py-4">Failed to load: ${escapeHtml(error.message)}</td></tr>`;
  }
}
