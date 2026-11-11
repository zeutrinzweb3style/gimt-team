import { state } from "./state.js";
import { $, escapeHtml, fetchJson } from "./utils.js";

export function renderCommunitySummary() {
  const host = $("#community-summary-content");
  const summary = state.communitySummary.data;
  if (state.communitySummary.loading) {
    host.innerHTML = '<p class="text-sm text-slate-500 dark:text-slate-400">Loading the daily record…</p>';
    return;
  }
  if (!summary) {
    host.innerHTML = '<div class="rounded-xl border border-dashed border-slate-300 dark:border-slate-700 p-6 text-center text-sm text-slate-500 dark:text-slate-400">No summary record exists for this date yet. Run the daily community-summary cron after deployment.</div>';
    return;
  }
  const concerns = Array.isArray(summary.concerns) ? summary.concerns : [];
  host.innerHTML = `
    <div class="mb-4 rounded-xl border border-teal-100 dark:border-teal-900/60 bg-teal-50/60 dark:bg-teal-950/20 p-4">
      <div class="text-xs font-semibold uppercase tracking-wide text-teal-700 dark:text-teal-300">${escapeHtml(summary.date || state.communitySummary.date)} · UTC</div>
      <h3 class="mt-2 text-lg font-semibold">${escapeHtml(summary.headline || "Community concerns summary")}</h3>
    </div>
    <div class="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
      ${[
        ["Questions", summary.total_questions],
        ["Open", summary.open_questions],
        ["Resolved", summary.resolved_questions],
        ["Needs moderator", summary.needs_moderator_review]
      ].map(([label, value]) => `<div class="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-4"><div class="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">${escapeHtml(label)}</div><div class="mt-2 text-2xl font-bold">${escapeHtml(value)}</div></div>`).join("")}
    </div>
    <div>
      <h3 class="text-base font-semibold mb-3">Main concerns</h3>
      ${concerns.length ? `<div class="space-y-3">${concerns.map((concern) => `<article class="rounded-xl border border-slate-200 dark:border-slate-700 p-4"><div class="flex items-start justify-between gap-3"><h4 class="font-semibold">${escapeHtml(concern.category)}</h4><span class="pill pill-blue">${escapeHtml(concern.count)} question${Number(concern.count) === 1 ? "" : "s"}</span></div><p class="mt-2 text-sm text-slate-600 dark:text-slate-300">${escapeHtml(concern.example || "No example available.")}</p><p class="mt-2 text-xs text-slate-500 dark:text-slate-400">${escapeHtml(concern.open_count)} open · ${escapeHtml(concern.needs_moderator_count)} need moderator review</p></article>`).join("")}</div>` : '<p class="text-sm text-slate-500 dark:text-slate-400">No user questions were recorded for this date.</p>'}
    </div>`;
}

export async function loadCommunitySummary() {
  const dateInput = $("#community-summary-date");
  const date = dateInput.value || new Date().toISOString().slice(0, 10);
  state.communitySummary.date = date;
  state.communitySummary.loading = true;
  renderCommunitySummary();
  try {
    const result = await fetchJson("/api/web/activity?action=COMMUNITY_CONCERNS_DAILY_SUMMARY&limit=400");
    const record = (result.activities || []).find((item) => item.metadata?.summary_date === date);
    state.communitySummary.data = record?.metadata?.summary ?? null;
  } catch (error) {
    state.communitySummary.data = null;
    $("#community-summary-content").innerHTML = `<div class="rounded-xl border border-rose-200 dark:border-rose-900 p-4 text-sm text-rose-700 dark:text-rose-300">Could not load this record: ${escapeHtml(error.message || "Unknown error")}</div>`;
  } finally {
    state.communitySummary.loading = false;
    if (state.communitySummary.data) renderCommunitySummary();
  }
}
