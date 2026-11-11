import { ACTION_LABEL, ACTION_PILL, state } from "./state.js";
import { $, applySortIndicators, compareValues, currentWeekKey, escapeHtml, fetchJson, fmtRelative, fmtTimeUtc, fmtWeekLabel, groupByWeek, memberLink, pill, weekKeyFromIso } from "./utils.js";

export function filterActivityRows(rows, filters) {
  const search = filters.search.trim().toLowerCase();
  return rows.filter((row) => {
    if (filters.member_id && row.member_id !== filters.member_id) return false;
    if (filters.action && row.action !== filters.action) return false;
    if (search && !`${row.message ?? ""} ${row.member_name ?? ""} ${row.action ?? ""}`.toLowerCase().includes(search)) return false;
    return true;
  });
}

export function sortActivityRows(rows, sort) {
  return rows.slice().sort((a, b) => {
    const cmp = compareValues(a[sort.key], b[sort.key]);
    return sort.ascending ? cmp : -cmp;
  });
}

export function renderActivityRow(row) {
  const label = ACTION_LABEL[row.action] || row.action;
  const pillCls = ACTION_PILL[row.action] || "pill-slate";
  const when = fmtTimeUtc(row.created_at);
  const rel = fmtRelative(row.created_at);
  return `
    <tr>
      <td class="mono whitespace-nowrap">
        <div>${escapeHtml(when)}</div>
        <div class="text-[10px] text-slate-400">${escapeHtml(rel)}</div>
      </td>
      <td class="whitespace-nowrap">${memberLink(row.member_id, row.member_name)}</td>
      <td class="whitespace-nowrap">${pill(pillCls, label)}</td>
      <td class="whitespace-pre-wrap break-words">${escapeHtml(row.message)}</td>
    </tr>
  `;
}

export function summarizeActionCounts(rows) {
  const counts = new Map();
  for (const r of rows) {
    counts.set(r.action, (counts.get(r.action) || 0) + 1);
  }
  const order = Object.keys(ACTION_LABEL).filter((a) => counts.has(a));
  for (const a of counts.keys()) if (!order.includes(a)) order.push(a);
  return order.map((a) => ({ action: a, label: ACTION_LABEL[a] || a, count: counts.get(a) }));
}

export function renderActivity() {
  const { rows, sort, filters, expandedWeeks } = state.activity;
  const filtered = filterActivityRows(rows, filters);
  applySortIndicators("#activity-table", sort.key, sort.ascending);

  const currentKey = currentWeekKey();
  const weekMap = groupByWeek(filtered, (r) => weekKeyFromIso(r.created_at));
  const weekKeys = Array.from(weekMap.keys()).sort().reverse();

  const currentRows = weekMap.get(currentKey) || [];
  const sortedCurrent = sortActivityRows(currentRows, sort);

  const tbody = $("#activity-body");
  if (!sortedCurrent.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="text-center text-sm text-slate-500 dark:text-slate-400 py-4">No activity in the current week.</td></tr>';
  } else {
    tbody.innerHTML = sortedCurrent.map(renderActivityRow).join("");
  }

  const pastKeys = weekKeys.filter((k) => k !== currentKey);
  const pastContainer = $("#activity-past");
  if (!pastKeys.length) {
    pastContainer.innerHTML = '<p class="text-xs text-slate-500 dark:text-slate-400">No past weeks in the loaded data.</p>';
  } else {
    pastContainer.innerHTML = pastKeys
      .map((key) => {
        const weekRows = weekMap.get(key);
        const sortedWeek = sortActivityRows(weekRows, sort);
        const isOpen = expandedWeeks.has(key);
        const summary = summarizeActionCounts(weekRows);
        const summaryText = summary.length
          ? summary.map((s) => `${s.count} ${s.label}`).join(" · ")
          : `${weekRows.length} entries`;
        return `
          <article class="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
            <button class="week-toggle" data-week="${escapeHtml(key)}" data-week-section="activity" aria-expanded="${isOpen}">
              <span class="week-chevron">${isOpen ? "▼" : "▶"}</span>
              <span class="week-label">Week ${escapeHtml(fmtWeekLabel(key))}</span>
              <span class="week-meta">${escapeHtml(summaryText)}</span>
            </button>
            ${isOpen ? `
              <div class="overflow-x-auto border-t border-slate-200 dark:border-slate-800">
                <table class="sheet">
                  <thead>
                    <tr>
                      <th>When (UTC)</th>
                      <th>Member</th>
                      <th>Action</th>
                      <th>Message</th>
                    </tr>
                  </thead>
                  <tbody>${sortedWeek.map(renderActivityRow).join("")}</tbody>
                </table>
              </div>
            ` : ""}
          </article>
        `;
      })
      .join("");
  }

  $("#activity-count").textContent =
    `${sortedCurrent.length} current-week row${sortedCurrent.length === 1 ? "" : "s"}` +
    (pastKeys.length ? ` · ${pastKeys.length} past week${pastKeys.length === 1 ? "" : "s"}` : "") +
    (filters.member_id || filters.action || filters.search ? ` (filtered from ${rows.length})` : "");
}

export async function loadActivity() {
  const qs = new URLSearchParams({ limit: "200" });
  $("#activity-body").innerHTML = '<tr><td colspan="4" class="text-center text-sm text-slate-500 dark:text-slate-400 py-4">Loading…</td></tr>';
  $("#activity-past").innerHTML = "";
  try {
    const data = await fetchJson(`/api/web/activity?${qs.toString()}`);
    state.activity.rows = data.activities;
    renderActivity();
  } catch (error) {
    $("#activity-body").innerHTML = `<tr><td colspan="4" class="text-center text-sm text-red-600 dark:text-red-400 py-4">Failed to load: ${escapeHtml(error.message)}</td></tr>`;
  }
}
