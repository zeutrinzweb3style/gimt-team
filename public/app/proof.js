import { PROOF_STATUS_PILL, state } from "./state.js";
import { $, currentWeekKey, escapeHtml, fetchJson, fmtTimeUtc, fmtWeekLabel, groupByWeek, linkifyProofContent, memberLink, pill, renderProofAttachments, weekKeyFromDateString } from "./utils.js";

export function renderProofCard(row) {
  const statusCls = PROOF_STATUS_PILL[row.status] || "pill-slate";
  return `
    <article class="rounded-md border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 p-3">
      <header class="flex items-center justify-between gap-2 flex-wrap">
        <div class="flex items-center gap-2 flex-wrap">
          ${pill("pill-slate", row.work_date_utc)}
          <span>${memberLink(row.member_id, row.member_name)}</span>
          ${pill(statusCls, row.status)}
          ${row.proof_type ? pill("pill-blue", row.proof_type) : ""}
        </div>
        <div class="text-xs text-slate-500 dark:text-slate-400 mono">${escapeHtml(fmtTimeUtc(row.submitted_at_utc))}</div>
      </header>
      <div class="mt-2 text-sm whitespace-pre-wrap break-words text-slate-800 dark:text-slate-100">${linkifyProofContent(row.proof_content)}</div>
      ${renderProofAttachments(row)}
    </article>
  `;
}

export function renderProof() {
  const list = $("#proof-list");
  const rows = state.proof.rows;
  const { expandedWeeks } = state.proof;

  if (!rows.length) {
    list.innerHTML = '<p class="text-sm text-slate-500 dark:text-slate-400">No proof of work submissions in this view.</p>';
    $("#proof-count").textContent = "0 submissions";
    return;
  }

  const currentKey = currentWeekKey();
  const weekMap = groupByWeek(rows, (r) => weekKeyFromDateString(r.work_date_utc));
  const weekKeys = Array.from(weekMap.keys()).sort().reverse();

  list.innerHTML = weekKeys
    .map((key) => {
      const weekRows = weekMap.get(key);
      const isCurrent = key === currentKey;
      const isOpen = isCurrent || expandedWeeks.has(key);

      const byMember = new Map();
      for (const r of weekRows) {
        byMember.set(r.member_id, (byMember.get(r.member_id) || 0) + 1);
      }
      const memberSummary = Array.from(byMember.entries())
        .map(([memberId, count]) => {
          const name = weekRows.find((r) => r.member_id === memberId)?.member_name || memberId;
          return `${escapeHtml(name)}: ${count}`;
        })
        .join(" · ");

      return `
        <article class="rounded-lg border ${isCurrent ? "border-slate-300 dark:border-slate-700" : "border-slate-200 dark:border-slate-800"} bg-white dark:bg-slate-900">
          <button class="week-toggle" data-week="${escapeHtml(key)}" data-week-section="proof" aria-expanded="${isOpen}">
            <span class="week-chevron">${isOpen ? "▼" : "▶"}</span>
            <span class="week-label">${isCurrent ? "This week" : "Week"} ${escapeHtml(fmtWeekLabel(key))}</span>
            <span class="week-meta">${weekRows.length} submission${weekRows.length === 1 ? "" : "s"}${memberSummary ? ` · ${memberSummary}` : ""}</span>
          </button>
          ${isOpen ? `
            <div class="p-3 border-t border-slate-200 dark:border-slate-800 space-y-2">
              ${weekRows.map(renderProofCard).join("")}
            </div>
          ` : ""}
        </article>
      `;
    })
    .join("");

  $("#proof-count").textContent = `${rows.length} submission${rows.length === 1 ? "" : "s"} · ${weekKeys.length} week${weekKeys.length === 1 ? "" : "s"}`;
}

export async function loadProof() {
  const memberId = $("#proof-member").value;
  const from = $("#proof-from").value;
  const to = $("#proof-to").value;
  const qs = new URLSearchParams({ limit: "500" });
  if (memberId) qs.set("member_id", memberId);
  if (from) qs.set("from", from);
  if (to) qs.set("to", to);
  $("#proof-list").innerHTML = '<p class="text-sm text-slate-500 dark:text-slate-400">Loading…</p>';
  try {
    const data = await fetchJson(`/api/web/proof-submissions?${qs.toString()}`);
    state.proof.rows = data.submissions;
    renderProof();
  } catch (error) {
    $("#proof-list").innerHTML = `<p class="text-sm text-red-600 dark:text-red-400">Failed: ${escapeHtml(error.message)}</p>`;
  }
}
