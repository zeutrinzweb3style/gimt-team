import { state } from "./state.js";
import { $, $all, escapeHtml, fetchJson } from "./utils.js";

export async function loadMembers() {
  if (state.members.length) {
    renderHomeMembersGrid();
    return state.members;
  }
  const data = await fetchJson("/api/web/members");
  state.members = data.members;
  for (const select of $all("[data-members-select]")) {
    select.innerHTML =
      '<option value="">All members</option>' +
      state.members
        .map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.name)}</option>`)
        .join("");
  }
  renderHomeMembersGrid();
  return state.members;
}

export function memberById(memberId) {
  return state.members.find((m) => m.id === memberId);
}

export function renderHomeMembersGrid() {
  const container = $("#home-members-grid");
  if (!container) return;
  if (!state.members.length) {
    container.innerHTML = '<p class="text-sm text-slate-500 dark:text-slate-400 col-span-full">No members available.</p>';
    return;
  }
  container.innerHTML = state.members
    .map((member) => `
      <button type="button" class="member-tile" data-member-tile="${escapeHtml(member.id)}">
        <span class="tile-name">${escapeHtml(member.name)}</span>
        <span class="tile-shift">${escapeHtml(member.shift_start_utc)}\u2013${escapeHtml(member.shift_end_utc)} UTC</span>
        <span class="tile-zone">${escapeHtml(member.timezone)}</span>
        <span class="tile-cta">Open dedicated page \u2192</span>
      </button>
    `)
    .join("");
}

export function fmtShiftLabel(member) {
  if (!member) return "";
  return `${member.shift_start_utc}\u2013${member.shift_end_utc} UTC \u00b7 ${member.timezone}`;
}
