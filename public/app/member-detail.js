import { renderProofCard } from "./proof.js";
import { ACTION_LABEL, ACTION_PILL, state } from "./state.js";
import { $, escapeHtml, fetchJson, fmtDateHuman, fmtTimeUtc, groupName, pill } from "./utils.js";

export async function openMemberDetail(memberId, memberName) {
  state.memberDetail.open = true;
  state.memberDetail.memberId = memberId;
  state.memberDetail.memberName = memberName;
  $("#member-modal-name").textContent = memberName;
  $("#member-modal-section-messages").innerHTML = '<p class="text-sm text-slate-500 dark:text-slate-400">Loading…</p>';
  $("#member-modal-section-activity").innerHTML = '<p class="text-sm text-slate-500 dark:text-slate-400">Loading…</p>';
  $("#member-modal-section-proof").innerHTML = '<p class="text-sm text-slate-500 dark:text-slate-400">Loading…</p>';
  const modal = $("#member-modal");
  modal.classList.add("open");
  document.body.classList.add("modal-open");

  const qs = new URLSearchParams({ member_id: memberId, limit: "200" });
  try {
    const [stats, activity, proof] = await Promise.all([
      fetchJson(`/api/web/group-stats?${new URLSearchParams({ member_id: memberId, limit: "200" }).toString()}`),
      fetchJson(`/api/web/activity?${new URLSearchParams({ member_id: memberId, limit: "200" }).toString()}`),
      fetchJson(`/api/web/proof-submissions?${qs.toString()}`)
    ]);
    renderMemberMessages(stats.group_stats);
    renderMemberActivity(activity.activities);
    renderMemberProof(proof.submissions);
  } catch (error) {
    const msg = `<p class="text-sm text-red-600 dark:text-red-400">Failed: ${escapeHtml(error.message)}</p>`;
    $("#member-modal-section-messages").innerHTML = msg;
    $("#member-modal-section-activity").innerHTML = msg;
    $("#member-modal-section-proof").innerHTML = msg;
  }
}

export function closeMemberDetail() {
  state.memberDetail.open = false;
  $("#member-modal").classList.remove("open");
  document.body.classList.remove("modal-open");
}

export function renderMemberMessages(rows) {
  const el = $("#member-modal-section-messages");
  if (!rows.length) {
    el.innerHTML = '<p class="text-sm text-slate-500 dark:text-slate-400">No message data.</p>';
    return;
  }
  const total = rows.reduce((s, r) => s + r.message_count, 0);
  const max = Math.max(...rows.map((r) => r.message_count), 1);
  const sorted = rows.slice().sort((a, b) => b.work_date_utc.localeCompare(a.work_date_utc));
  el.innerHTML = `
    <div class="mb-2 text-sm text-slate-600 dark:text-slate-300"><span class="mono">${total}</span> messages across <span class="mono">${rows.length}</span> group-day row${rows.length === 1 ? "" : "s"}</div>
    <div class="space-y-0.5">
      ${sorted
        .map((d) => {
          const pct = Math.round((d.message_count / max) * 100);
          return `
            <div class="sparkline-row">
              <span class="spark-date">${escapeHtml(fmtDateHuman(d.work_date_utc))} · ${escapeHtml(groupName(d))}</span>
              <div class="spark-bar"><div class="spark-fill" style="width:${pct}%"></div></div>
              <span class="spark-count">${d.message_count}</span>
            </div>
          `;
        })
        .join("")}
    </div>
  `;
}

export function renderMemberActivity(rows) {
  const el = $("#member-modal-section-activity");
  if (!rows.length) {
    el.innerHTML = '<p class="text-sm text-slate-500 dark:text-slate-400">No activity entries.</p>';
    return;
  }
  el.innerHTML = `
    <div class="space-y-1.5">
      ${rows
        .map((row) => {
          const label = ACTION_LABEL[row.action] || row.action;
          const pillCls = ACTION_PILL[row.action] || "pill-slate";
          return `
            <div class="flex items-start gap-2 text-sm">
              <span class="mono text-xs text-slate-500 dark:text-slate-400 whitespace-nowrap pt-0.5">${escapeHtml(fmtTimeUtc(row.created_at))}</span>
              ${pill(pillCls, label)}
              <span class="text-slate-700 dark:text-slate-200 break-words">${escapeHtml(row.message)}</span>
            </div>
          `;
        })
        .join("")}
    </div>
  `;
}

export function renderMemberProof(rows) {
  const el = $("#member-modal-section-proof");
  if (!rows.length) {
    el.innerHTML = '<p class="text-sm text-slate-500 dark:text-slate-400">No proof of work submissions.</p>';
    return;
  }
  el.innerHTML = `
    <div class="space-y-2">
      ${rows.map(renderProofCard).join("")}
    </div>
  `;
}
