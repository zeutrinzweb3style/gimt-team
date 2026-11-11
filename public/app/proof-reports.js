import { renderProofCard } from "./proof.js";
import { $, escapeHtml, fetchJson } from "./utils.js";

const view = {
  activeType: "weekly",
  reports: { weekly: [], monthly: [] },
  loadedRows: new Map(),
  loadingKey: "",
  loading: false,
  error: ""
};

function manilaDateKey(value) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date(value));
  const part = (name) => parts.find((entry) => entry.type === name)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function generatedLabel(report) {
  const generatedAt = report.generated_at_utc || report.generated_at;
  if (!generatedAt) return "Saved report";
  return `Saved ${new Date(generatedAt).toLocaleString("en-PH", {
    timeZone: "Asia/Manila",
    dateStyle: "medium",
    timeStyle: "short"
  })} PHT`;
}

function renderMemberSummary(members = []) {
  if (!members.length) return '<p class="text-sm text-slate-500 dark:text-slate-400">No submissions were recorded for this period.</p>';
  return `
    <div class="proof-report-member-list">
      ${members.map((member) => `
        <div class="proof-report-member-row">
          <span class="font-medium">${escapeHtml(member.member_name || member.member_id)}</span>
          <span>${Number(member.submissions) || 0} proof${Number(member.submissions) === 1 ? "" : "s"}</span>
          <span class="text-slate-500 dark:text-slate-400">${Number(member.late_submissions) || 0} late</span>
        </div>
      `).join("")}
    </div>
  `;
}

function renderProofRows(rows) {
  if (!rows?.length) return '<p class="text-sm text-slate-500 dark:text-slate-400">No proof submissions were saved in this report period.</p>';
  return `<div class="space-y-2">${rows.map((row) => renderProofCard(row)).join("")}</div>`;
}

function renderExpandedDetails(report) {
  const reportKey = String(report.report_key ?? "");
  if (view.loadingKey === reportKey) return '<p class="mt-3 text-sm text-slate-500 dark:text-slate-400">Loading original proof entries…</p>';
  const rows = view.loadedRows.get(reportKey);
  if (!rows) return "";

  if (report.report_type === "monthly") {
    const weeks = Array.isArray(report.weeks) ? report.weeks : [];
    return `
      <div class="mt-4 space-y-3">
        ${weeks.map((week) => {
          const weekRows = rows.filter((row) => {
            const day = manilaDateKey(row.submitted_at_utc);
            return day >= week.start_date && day <= week.end_date;
          });
          return `
            <details class="proof-report-week">
              <summary>Week ${Number(week.week_number) || 0} · ${escapeHtml(week.start_date)}–${escapeHtml(week.end_date)} · ${Number(week.submissions) || 0} submissions · ${Number(week.late_submissions) || 0} late</summary>
              <div class="mt-3 space-y-3">
                ${renderMemberSummary(week.members)}
                ${renderProofRows(weekRows)}
              </div>
            </details>
          `;
        }).join("")}
      </div>
    `;
  }

  return `
    <div class="mt-4 space-y-3">
      ${renderMemberSummary(report.members)}
      ${renderProofRows(rows)}
    </div>
  `;
}

function renderReportCard(report) {
  const reportKey = String(report.report_key ?? "");
  const expanded = view.loadedRows.has(reportKey) || view.loadingKey === reportKey;
  const title = report.report_type === "monthly"
    ? `Monthly recap · ${String(report.period_start ?? "").slice(0, 7)}`
    : `Weekly update · ${report.period_start ?? "—"}–${report.period_end ?? "—"}`;
  const weeks = Array.isArray(report.weeks) ? report.weeks : [];
  const monthWeekLine = report.report_type === "monthly" && weeks.length
    ? `<p class="mt-2 text-xs text-slate-500 dark:text-slate-400">${weeks.map((week) => `Week ${Number(week.week_number) || 0}: ${Number(week.submissions) || 0}`).join(" · ")} submissions</p>`
    : "";

  return `
    <article class="proof-report-card">
      <div class="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h4 class="font-semibold text-slate-900 dark:text-slate-100">${escapeHtml(title)}</h4>
          <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">${escapeHtml(generatedLabel(report))} · Manila time</p>
        </div>
        <div class="proof-report-metrics">
          <span>${Number(report.total_submissions) || 0} submissions</span>
          <span>${Number(report.member_count) || 0} members</span>
          <span>${Number(report.late_submissions) || 0} late</span>
        </div>
      </div>
      ${monthWeekLine}
      <button type="button" class="proof-report-open mt-3" data-proof-report-key="${escapeHtml(reportKey)}" aria-expanded="${expanded}">
        ${expanded ? "Hide proof details" : "Review proof details"}
      </button>
      ${expanded ? `<div class="proof-report-details">${renderExpandedDetails(report)}</div>` : ""}
    </article>
  `;
}

export function renderProofReports() {
  const list = $("#proof-reports-list");
  if (!list) return;
  for (const button of document.querySelectorAll("[data-proof-report-mode]")) {
    const active = button.dataset.proofReportMode === view.activeType;
    button.setAttribute("aria-pressed", active ? "true" : "false");
    button.classList.toggle("is-active", active);
  }
  if (view.loading) {
    list.innerHTML = '<p class="text-sm text-slate-500 dark:text-slate-400">Loading saved reports…</p>';
    return;
  }
  if (view.error) {
    list.innerHTML = `<p class="text-sm text-red-600 dark:text-red-400">${escapeHtml(view.error)}</p>`;
    return;
  }
  const reports = view.reports[view.activeType];
  if (!reports.length) {
    const expected = view.activeType === "weekly"
      ? "The first archived update will appear after the next completed Sunday reporting week."
      : "The first monthly recap will appear on the first day of the next month.";
    list.innerHTML = `<p class="text-sm text-slate-500 dark:text-slate-400">No saved ${view.activeType} reports yet. ${expected}</p>`;
    return;
  }
  list.innerHTML = reports.map(renderReportCard).join("");
}

export async function loadProofReports() {
  const list = $("#proof-reports-list");
  if (!list) return;
  view.loading = true;
  view.error = "";
  renderProofReports();
  try {
    const [weekly, monthly] = await Promise.all([
      fetchJson("/api/web/proof-submissions?report_type=weekly"),
      fetchJson("/api/web/proof-submissions?report_type=monthly")
    ]);
    view.reports.weekly = weekly.reports ?? [];
    view.reports.monthly = monthly.reports ?? [];
  } catch (error) {
    view.error = error instanceof Error ? error.message : String(error);
  } finally {
    view.loading = false;
    renderProofReports();
  }
}

async function loadReportProofRows(report) {
  const reportKey = String(report.report_key ?? "");
  if (!reportKey || view.loadedRows.has(reportKey) || view.loadingKey) return;
  view.loadingKey = reportKey;
  renderProofReports();
  try {
    const endInclusive = new Date(new Date(report.end_utc_exclusive).getTime() - 1).toISOString();
    const rows = [];
    const pageSize = 500;
    for (let offset = 0; ; offset += pageSize) {
      const qs = new URLSearchParams({
        submitted_from: report.start_utc,
        submitted_to: endInclusive,
        limit: String(pageSize),
        offset: String(offset)
      });
      const data = await fetchJson(`/api/web/proof-submissions?${qs.toString()}`);
      rows.push(...(data.submissions ?? []));
      if ((data.submissions ?? []).length < pageSize) break;
    }
    view.loadedRows.set(reportKey, rows);
  } catch (error) {
    view.error = error instanceof Error ? error.message : String(error);
  } finally {
    view.loadingKey = "";
    renderProofReports();
  }
}

export function initProofReports() {
  for (const button of document.querySelectorAll("[data-proof-report-mode]")) {
    button.addEventListener("click", () => {
      view.activeType = button.dataset.proofReportMode === "monthly" ? "monthly" : "weekly";
      view.error = "";
      renderProofReports();
    });
  }
  $("#proof-reports-refresh")?.addEventListener("click", loadProofReports);
  $("#proof-reports-list")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-proof-report-key]");
    if (!button) return;
    const report = view.reports[view.activeType].find((entry) => entry.report_key === button.dataset.proofReportKey);
    if (!report) return;
    const key = String(report.report_key);
    if (view.loadedRows.has(key)) {
      view.loadedRows.delete(key);
      renderProofReports();
    } else {
      loadReportProofRows(report);
    }
  });
}
