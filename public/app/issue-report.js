import { issueCategories, normalizeIssueCategory } from "./issue-categories.js";
import { defaultMemberRange } from "./member-profile.js";
import { TICKET_STATUS_LABEL, TICKET_STATUS_PILL, state } from "./state.js";
import { switchTab } from "./tabs.js";
import { fmtReportDate, fmtReportDateShort } from "./tickets.js";
import { $, escapeHtml, fetchJson, fmtRelative, fmtTimeUtc, pill } from "./utils.js";

// Repeated Issue Report (own page per issue).
//
// Each repeated issue is reachable at its own URL, e.g.
//   /?issue=MiniPay+GoodDapp+Swap+Failed&from=2025-09-01&to=2025-09-02
// so the date range travels with the link and the report is shareable as-is.
// Tabs are used instead of separate HTML files so the single static entry point
// keeps working on both Vercel and Netlify without extra rewrites.

// Dates default to the last 7 UTC days, matching the cron report window.
export function defaultIssueRange() {
  return defaultMemberRange();
}

export function getIssueUrlParams() {
  const params = new URLSearchParams(window.location.search);
  return {
    category: normalizeIssueCategory(params.get("issue") || params.get("category")),
    from: params.get("from") || "",
    to: params.get("to") || ""
  };
}

export function buildIssueReportHref(category, from, to) {
  const params = new URLSearchParams();
  params.set("issue", category);
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  return `${window.location.pathname}?${params.toString()}`;
}

export function updateIssueUrlParams({ category, from, to, replace = false }) {
  const url = new URL(window.location.href);
  if (category) {
    url.searchParams.set("issue", category);
    if (from) url.searchParams.set("from", from); else url.searchParams.delete("from");
    if (to) url.searchParams.set("to", to); else url.searchParams.delete("to");
    // Issue and member routes are mutually exclusive; drop the member params so
    // a shared link does not open two pages at once.
    url.searchParams.delete("member");
    url.searchParams.delete("view");
  } else {
    url.searchParams.delete("issue");
    // from/to are shared by the member and issue routes; only clear them when no
    // other route still owns the window.
    if (!url.searchParams.get("member")) {
      url.searchParams.delete("from");
      url.searchParams.delete("to");
    }
  }
  const next = `${url.pathname}${url.search}${url.hash}`;
  if (replace) window.history.replaceState({}, "", next);
  else window.history.pushState({}, "", next);
}

export function renderIssueCategoryOptions() {
  const select = $("#issue-category");
  if (!select) return;
  const current = state.issueReport.category;
  select.innerHTML = ['<option value="">Select an issue…</option>']
    .concat(issueCategories.map((category) =>
      `<option value="${escapeHtml(category)}"${category === current ? " selected" : ""}>${escapeHtml(category)}</option>`
    ))
    .join("");
  select.value = current;
}

export function openIssueReport(category, from, to, opts = {}) {
  const normalized = normalizeIssueCategory(category);
  if (!normalized) return;
  const fallback = defaultIssueRange();
  state.issueReport.category = normalized;
  state.issueReport.from = from || fallback.from;
  state.issueReport.to = to || fallback.to;
  updateIssueUrlParams({
    category: normalized,
    from: state.issueReport.from,
    to: state.issueReport.to,
    replace: Boolean(opts.replace)
  });
  switchTab("issue-report");
}

export function renderIssueReportHeader() {
  const { category, from, to } = state.issueReport;
  $("#issue-report-title").textContent = category ? `${category} — Report` : "Repeated Issue Report";
  $("#issue-report-period").textContent =
    from && to
      ? `Reporting period: ${fmtReportDate(from)} to ${fmtReportDate(to)} (UTC)`
      : "";
  $("#issue-from").value = from;
  $("#issue-to").value = to;
  renderIssueCategoryOptions();
}

export function renderIssueReportPage(report) {
  const summary = $("#issue-report-summary");
  const daily = $("#issue-report-daily");
  const tbody = $("#issue-report-body");

  if (!report) {
    summary.innerHTML = "";
    daily.innerHTML = "";
    tbody.innerHTML = '<tr><td colspan="6" class="px-3 py-4 text-center text-sm text-slate-500 dark:text-slate-400">Pick an issue to see its report.</td></tr>';
    $("#issue-report-count").textContent = "";
    return;
  }

  const cards = [
    { label: "Total reports", value: report.total_tickets, tone: "text-teal-700 dark:text-teal-300" },
    { label: "Open", value: report.open_count, tone: "text-amber-600 dark:text-amber-400" },
    { label: "Closed", value: report.closed_count, tone: "text-slate-700 dark:text-slate-200" },
    { label: "Busiest day", value: report.busiest_day ? `${report.busiest_day.count} on ${fmtReportDateShort(report.busiest_day.date)}` : "—", tone: "text-slate-700 dark:text-slate-200" }
  ];
  summary.innerHTML = cards.map((card) => `
    <div class="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-3 shadow-sm">
      <div class="text-[10px] uppercase tracking-wide text-slate-400">${escapeHtml(card.label)}</div>
      <div class="mt-1 text-lg font-bold ${card.tone}">${escapeHtml(card.value)}</div>
    </div>
  `).join("");

  const days = Array.isArray(report.daily_counts) ? report.daily_counts : [];
  daily.innerHTML = days.length
    ? days.map((day) => `
        <div class="issue-day-cell${Number(day.count) > 0 ? " has-reports" : ""}">
          <div class="text-[11px] text-slate-500 dark:text-slate-400">${escapeHtml(fmtReportDateShort(day.date))}</div>
          <div class="text-sm font-semibold">${escapeHtml(day.count)}</div>
        </div>
      `).join("")
    : '<p class="text-xs text-slate-500 dark:text-slate-400">No daily breakdown for this period.</p>';

  const rows = Array.isArray(report.tickets) ? report.tickets : [];
  tbody.innerHTML = rows.length
    ? rows.map((ticket) => {
        const status = pill(TICKET_STATUS_PILL[ticket.status] || "pill-slate", TICKET_STATUS_LABEL[ticket.status] || ticket.status);
        return `
          <tr>
            <td class="mono ticket-cell-nowrap font-semibold">#${escapeHtml(ticket.ticket_code || String(ticket.id).slice(0, 8))}</td>
            <td class="mono ticket-cell-nowrap">
              <div>${escapeHtml(fmtTimeUtc(ticket.created_at))}</div>
              <div class="text-[10px] text-slate-400">${escapeHtml(fmtRelative(ticket.created_at))}</div>
            </td>
            <td class="ticket-cell-nowrap">${escapeHtml(ticket.group_title || (ticket.telegram_chat_id ? `Chat ${ticket.telegram_chat_id}` : "—"))}</td>
            <td class="ticket-cell-nowrap">${escapeHtml(ticket.opened_by_name)}</td>
            <td>${status}</td>
            <td class="text-xs text-slate-500 dark:text-slate-400">${escapeHtml(ticket.summary || "—")}</td>
          </tr>
        `;
      }).join("")
    : '<tr><td colspan="6" class="px-3 py-4 text-center text-sm text-slate-500 dark:text-slate-400">No tickets of this issue in the selected period.</td></tr>';

  const activeDays = days.filter((day) => Number(day.count) > 0).length;
  $("#issue-report-count").textContent =
    `${rows.length} ticket${rows.length === 1 ? "" : "s"} · reported on ${activeDays} of ${days.length} day${days.length === 1 ? "" : "s"} in this period`;
}

export async function loadIssueReport() {
  const { category, from, to } = state.issueReport;
  renderIssueReportHeader();
  if (!category) {
    renderIssueReportPage(null);
    return;
  }

  state.issueReport.loading = true;
  $("#issue-report-body").innerHTML = '<tr><td colspan="6" class="px-3 py-4 text-center text-sm text-slate-500 dark:text-slate-400">Loading report…</td></tr>';

  const qs = new URLSearchParams({ category });
  if (from) qs.set("from", from);
  if (to) qs.set("to", to);

  try {
    const data = await fetchJson(`/api/web/issue-report?${qs.toString()}`);
    state.issueReport.data = data.report || null;
    // The API echoes the resolved window, which may differ from what was asked
    // for (e.g. a clamped or swapped range) — keep the URL truthful.
    if (data.report) {
      state.issueReport.from = data.report.range_from;
      state.issueReport.to = data.report.range_to;
      updateIssueUrlParams({
        category: state.issueReport.category,
        from: state.issueReport.from,
        to: state.issueReport.to,
        replace: true
      });
    }
    renderIssueReportHeader();
    renderIssueReportPage(state.issueReport.data);
  } catch (error) {
    state.issueReport.data = null;
    $("#issue-report-body").innerHTML = `<tr><td colspan="6" class="px-3 py-4 text-center text-sm text-red-600 dark:text-red-400">Failed to load report: ${escapeHtml(error.message)}</td></tr>`;
    $("#issue-report-summary").innerHTML = "";
    $("#issue-report-daily").innerHTML = "";
    $("#issue-report-count").textContent = "";
  } finally {
    state.issueReport.loading = false;
  }
}
