import { state } from "./state.js";
import { $, currentWeekKey, escapeHtml, fetchJson, fmtDateHuman, fmtTimeUtc, fmtWeekLabel, groupByWeek, groupName, groupPill, memberLink, weekKeyFromDateString } from "./utils.js";

export function renderStatsGroupFilter(groups) {
  const select = $("#stats-group-filter");
  const current = state.stats.selectedGroupId;
  select.innerHTML = '<option value="">All groups</option>' + groups
    .map((group) => `<option value="${escapeHtml(group.telegram_chat_id)}">${escapeHtml(group.display_name || group.title || `Chat ${group.telegram_chat_id}`)}</option>`)
    .join("");
  if (current && groups.some((group) => String(group.telegram_chat_id) === current)) {
    select.value = current;
  } else {
    state.stats.selectedGroupId = "";
    select.value = "";
  }
}

export function renderTotalsAside(rows) {
  const totals = new Map();
  const groupTotals = new Map();
  for (const row of rows) {
    const entry = totals.get(row.member_id) ?? { member_id: row.member_id, member_name: row.member_name, total: 0 };
    entry.total += row.message_count;
    totals.set(row.member_id, entry);

    const groupEntry = groupTotals.get(row.telegram_chat_id) ?? { name: groupName(row), total: 0 };
    groupEntry.total += row.message_count;
    groupTotals.set(row.telegram_chat_id, groupEntry);
  }
  const groupSummary = Array.from(groupTotals.values()).sort((a, b) => b.total - a.total);
  $("#stats-group-summary").textContent = groupSummary.length
    ? groupSummary.map((g) => `${g.name}: ${g.total} msg${g.total === 1 ? "" : "s"}`).join(" · ")
    : "";
  const totalList = Array.from(totals.values()).sort((a, b) => b.total - a.total);
  const max = totalList[0]?.total || 1;
  const totalsEl = $("#stats-totals");
  if (!totalList.length) {
    totalsEl.innerHTML = '<p class="text-sm text-slate-500 dark:text-slate-400">No data in this range.</p>';
    return;
  }
  totalsEl.innerHTML = totalList
    .map((t) => {
      const pct = Math.round((t.total / max) * 100);
      return `
        <div class="rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-2.5">
          <div class="flex items-center justify-between text-sm">
            <span>${memberLink(t.member_id, t.member_name)}</span>
            <span class="mono text-xs text-slate-500 dark:text-slate-400">${t.total} msgs</span>
          </div>
          <div class="mt-1.5 h-1.5 bg-slate-200 dark:bg-slate-800 rounded overflow-hidden">
            <div class="h-full bg-slate-700 dark:bg-slate-300" style="width:${pct}%"></div>
          </div>
        </div>
      `;
    })
    .join("");
}

export function renderStatsByDateBody(rows) {
  const byDate = new Map();
  for (const row of rows) {
    if (!byDate.has(row.work_date_utc)) byDate.set(row.work_date_utc, []);
    byDate.get(row.work_date_utc).push(row);
  }
  const dates = Array.from(byDate.keys()).sort().reverse();
  if (!dates.length) {
    return '<p class="text-sm text-slate-500 dark:text-slate-400 px-2 py-2">No daily data.</p>';
  }
  return dates
    .map((date) => {
      const dateRows = byDate.get(date).slice().sort((a, b) => b.message_count - a.message_count);
      const total = dateRows.reduce((sum, r) => sum + r.message_count, 0);
      const maxCount = dateRows[0]?.message_count || 1;
      const peakCount = dateRows[0]?.message_count || 0;
      return `
        <div class="px-3 py-2 border-t border-slate-100 dark:border-slate-800 first:border-t-0">
          <div class="flex items-center justify-between mb-1">
            <h5 class="text-sm font-medium">${escapeHtml(fmtDateHuman(date))}</h5>
            <span class="text-xs text-slate-500 dark:text-slate-400 mono">Total: ${total} msgs</span>
          </div>
          <div class="space-y-0.5">
            ${dateRows
              .map((r) => {
                const isPeak = r.message_count === peakCount && peakCount > 0;
                const pct = Math.round((r.message_count / maxCount) * 100);
                return `
                  <div class="stat-row${isPeak ? " peak" : ""}">
                    <span class="stat-name">${isPeak ? '<span class="peak-star" title="Top messenger this day">★</span> ' : ""}${memberLink(r.member_id, r.member_name)} ${groupPill(r)}</span>
                    <div class="stat-bar"><div class="stat-bar-fill" style="width:${pct}%"></div></div>
                    <span class="stat-count">${r.message_count}</span>
                    <span class="stat-last">${escapeHtml(fmtTimeUtc(r.last_message_at_utc))}</span>
                  </div>
                `;
              })
              .join("")}
          </div>
        </div>
      `;
    })
    .join("");
}

export function renderSparkline(days, max) {
  if (!days.length) return "";
  const width = 80;
  const height = 18;
  const n = days.length;
  const step = n > 1 ? width / (n - 1) : 0;
  const points = days
    .map((d, i) => {
      const x = i * step;
      const y = height - (d.message_count / max) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return `
    <svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" preserveAspectRatio="none" aria-hidden="true">
      <polyline points="${points}" fill="none" stroke="currentColor" stroke-width="1.5" class="text-slate-500 dark:text-slate-300" />
    </svg>
  `;
}

export function renderStatsByMemberBody(rows) {
  const byMember = new Map();
  for (const row of rows) {
    const key = `${row.member_id}:${row.telegram_chat_id}`;
    if (!byMember.has(key)) {
      byMember.set(key, { member_id: row.member_id, member_name: row.member_name, group_name: groupName(row), days: [] });
    }
    byMember.get(key).days.push(row);
  }
  const members = Array.from(byMember.values()).sort((a, b) => {
    const totA = a.days.reduce((s, d) => s + d.message_count, 0);
    const totB = b.days.reduce((s, d) => s + d.message_count, 0);
    return totB - totA;
  });
  if (!members.length) {
    return '<p class="text-sm text-slate-500 dark:text-slate-400 px-2 py-2">No data.</p>';
  }
  return members
    .map((m) => {
      const days = m.days.slice().sort((a, b) => a.work_date_utc.localeCompare(b.work_date_utc));
      const total = days.reduce((s, d) => s + d.message_count, 0);
      const max = Math.max(...days.map((d) => d.message_count), 1);
      const sparkline = renderSparkline(days, max);
      return `
        <div class="px-3 py-2 border-t border-slate-100 dark:border-slate-800 first:border-t-0">
          <div class="flex items-center justify-between mb-1 gap-3">
            <h5 class="text-sm font-medium">${memberLink(m.member_id, m.member_name)} <span class="text-xs text-slate-500 dark:text-slate-400">· ${escapeHtml(m.group_name)}</span></h5>
            <div class="flex items-center gap-3">
              ${sparkline}
              <span class="text-xs text-slate-500 dark:text-slate-400 mono whitespace-nowrap">Total: ${total} msgs</span>
            </div>
          </div>
          <div class="space-y-0.5">
            ${days
              .slice()
              .reverse()
              .map((d) => {
                const pct = Math.round((d.message_count / max) * 100);
                return `
                  <div class="sparkline-row">
                    <span class="spark-date">${escapeHtml(fmtDateHuman(d.work_date_utc))}</span>
                    <div class="spark-bar"><div class="spark-fill" style="width:${pct}%"></div></div>
                    <span class="spark-count">${d.message_count}</span>
                  </div>
                `;
              })
              .join("")}
          </div>
        </div>
      `;
    })
    .join("");
}

export function renderWeeklyStatsTotals(rows) {
  const totals = new Map();
  for (const row of rows) {
    const entry = totals.get(row.member_id) ?? { member_id: row.member_id, member_name: row.member_name, total: 0 };
    entry.total += row.message_count;
    totals.set(row.member_id, entry);
  }
  const list = Array.from(totals.values()).sort((a, b) => b.total - a.total);
  if (!list.length) return "";
  const max = list[0].total || 1;
  return list
    .map((t) => {
      const pct = Math.round((t.total / max) * 100);
      return `
        <div class="stat-row">
          <span class="stat-name">${memberLink(t.member_id, t.member_name)}</span>
          <div class="stat-bar"><div class="stat-bar-fill" style="width:${pct}%"></div></div>
          <span class="stat-count">${t.total}</span>
          <span class="stat-last">msgs</span>
        </div>
      `;
    })
    .join("");
}

export function renderStats() {
  const { rows, grouping, expandedWeeks, selectedGroupId } = state.stats;
  renderTotalsAside(rows);
  const selectedGroup = state.stats.groups.find((group) => String(group.telegram_chat_id) === selectedGroupId);
  const groupSuffix = selectedGroup ? ` · ${selectedGroup.display_name || selectedGroup.title || selectedGroup.telegram_chat_id}` : " · All groups";
  $("#stats-section-title").textContent =
    (grouping === "date" ? "Weekly log (grouped by date)" : "Weekly log (grouped by member)") + groupSuffix;

  const currentKey = currentWeekKey();
  const weekMap = groupByWeek(rows, (r) => weekKeyFromDateString(r.work_date_utc));
  const weekKeys = Array.from(weekMap.keys()).sort().reverse();

  const log = $("#stats-log");
  if (!weekKeys.length) {
    log.innerHTML = '<p class="text-sm text-slate-500 dark:text-slate-400">No data in this range.</p>';
    $("#stats-count").textContent = "";
    return;
  }

  log.innerHTML = weekKeys
    .map((key) => {
      const weekRows = weekMap.get(key);
      const isCurrent = key === currentKey;
      const isOpen = isCurrent || expandedWeeks.has(key);
      const total = weekRows.reduce((s, r) => s + r.message_count, 0);
      const body = grouping === "date" ? renderStatsByDateBody(weekRows) : renderStatsByMemberBody(weekRows);
      const summaryRows = renderWeeklyStatsTotals(weekRows);

      return `
        <article class="rounded-lg border ${isCurrent ? "border-slate-300 dark:border-slate-700" : "border-slate-200 dark:border-slate-800"} bg-white dark:bg-slate-900">
          <button class="week-toggle" data-week="${escapeHtml(key)}" data-week-section="stats" aria-expanded="${isOpen}" ${isCurrent ? 'data-week-current="true"' : ""}>
            <span class="week-chevron">${isOpen ? "▼" : "▶"}</span>
            <span class="week-label">${isCurrent ? "This week" : "Week"} ${escapeHtml(fmtWeekLabel(key))}</span>
            <span class="week-meta">Total: ${total} msgs</span>
          </button>
          ${!isOpen ? `<div class="px-3 pb-2">${summaryRows}</div>` : ""}
          ${isOpen ? `<div class="border-t border-slate-200 dark:border-slate-800">${body}</div>` : ""}
        </article>
      `;
    })
    .join("");

  $("#stats-count").textContent = `${rows.length} row${rows.length === 1 ? "" : "s"} loaded · ${weekKeys.length} week${weekKeys.length === 1 ? "" : "s"}`;
}

export async function loadStats() {
  const from = $("#stats-from").value;
  const to = $("#stats-to").value;
  const qs = new URLSearchParams({ limit: "1000" });
  if (state.stats.selectedGroupId) qs.set("telegram_chat_id", state.stats.selectedGroupId);
  if (from) qs.set("from", from);
  if (to) qs.set("to", to);
  $("#stats-log").innerHTML = '<p class="text-sm text-slate-500 dark:text-slate-400">Loading…</p>';
  $("#stats-totals").innerHTML = '<p class="text-sm text-slate-500 dark:text-slate-400">Loading…</p>';
  try {
    const data = await fetchJson(`/api/web/group-stats?${qs.toString()}`);
    state.stats.rows = data.group_stats;
    state.stats.groups = data.groups || [];
    renderStatsGroupFilter(state.stats.groups);
    renderStats();
  } catch (error) {
    $("#stats-log").innerHTML = `<p class="text-sm text-red-600 dark:text-red-400">Failed: ${escapeHtml(error.message)}</p>`;
    $("#stats-totals").innerHTML = "";
  }
}

export function setStatsGrouping(grouping) {
  state.stats.grouping = grouping;
  $("#stats-group-date").setAttribute("aria-selected", grouping === "date" ? "true" : "false");
  $("#stats-group-member").setAttribute("aria-selected", grouping === "member" ? "true" : "false");
  renderStats();
}
