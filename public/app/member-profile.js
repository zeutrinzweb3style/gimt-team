import { fmtShiftLabel, memberById } from "./members.js";
import { renderProofCard } from "./proof.js";
import { renderAvatar } from "./profile.js";
import { TICKET_STATUS_LABEL, TICKET_STATUS_PILL, state } from "./state.js";
import { renderTicketMessages } from "./tickets.js";
import { switchTab } from "./tabs.js";
import { $, escapeHtml, fetchJson, fmtDateHuman, fmtTimeUtc, pill, toIsoDate } from "./utils.js";

let profileLoadToken = 0;

export function defaultMemberRange() {
  const today = new Date();
  const start = new Date(today.getTime() - 6 * 24 * 60 * 60 * 1000);
  return { from: toIsoDate(start), to: toIsoDate(today) };
}

export function getMemberUrlParams() {
  const params = new URLSearchParams(window.location.search);
  return { memberId: params.get("member") || "", from: params.get("from") || "", to: params.get("to") || "", view: "" };
}

export function updateMemberUrlParams({ memberId, from, to, replace = false }) {
  const url = new URL(window.location.href);
  if (memberId) {
    url.searchParams.set("member", memberId);
    if (from) url.searchParams.set("from", from); else url.searchParams.delete("from");
    if (to) url.searchParams.set("to", to); else url.searchParams.delete("to");
    url.searchParams.delete("view");
    url.searchParams.delete("issue");
  } else {
    url.searchParams.delete("member");
    url.searchParams.delete("view");
    if (!url.searchParams.get("issue")) {
      url.searchParams.delete("from");
      url.searchParams.delete("to");
    }
  }
  const next = `${url.pathname}${url.search}${url.hash}`;
  if (replace) window.history.replaceState({}, "", next);
  else window.history.pushState({}, "", next);
}

function panelElements(kind) {
  return {
    button: $(`#member-${kind}-toggle`),
    count: $(`#member-${kind}-count`),
    panel: $(`#member-${kind}-panel`),
    list: $(`#member-${kind}-list`)
  };
}

function updatePanelButton(kind) {
  const { button, count } = panelElements(kind);
  const isProof = kind === "proof";
  const countValue = state.memberProfile[isProof ? "proofCount" : "ticketsCount"];
  const isOpen = Boolean(state.memberProfile[isProof ? "proofOpen" : "ticketsOpen"]);
  count.textContent = Number.isFinite(countValue)
    ? countValue.toLocaleString()
    : countValue === "unavailable" ? "—" : "…";
  button.setAttribute("aria-expanded", String(isOpen));
  button.classList.toggle("is-open", isOpen);
}

function setPanelOpen(kind, isOpen) {
  const { button, panel } = panelElements(kind);
  const isProof = kind === "proof";
  state.memberProfile[isProof ? "proofOpen" : "ticketsOpen"] = isOpen;
  panel.hidden = !isOpen;
  panel.classList.toggle("hidden", !isOpen);
  button.setAttribute("aria-expanded", String(isOpen));
  button.classList.toggle("is-open", isOpen);
}

function setMemberPanelCountsLoading() {
  state.memberProfile.proofCount = null;
  state.memberProfile.ticketsCount = null;
  updatePanelButton("proof");
  updatePanelButton("tickets");
}

function isCurrentProfile(target) {
  return state.memberProfile.memberId === target.memberId
    && state.memberProfile.from === target.from
    && state.memberProfile.to === target.to;
}

function buildProofQuery(target, countOnly = false) {
  const qs = new URLSearchParams({
    limit: countOnly ? "1000" : "500",
    member_id: target.memberId
  });
  if (countOnly) qs.set("count_only", "1");
  if (target.from) qs.set("from", target.from);
  if (target.to) qs.set("to", target.to);
  return qs;
}

function buildTicketQuery(target, countOnly = false) {
  const qs = new URLSearchParams({
    limit: "1000",
    member_id: target.memberId
  });
  if (countOnly) qs.set("count_only", "1");
  if (target.from) qs.set("from", target.from);
  if (target.to) qs.set("to", target.to);
  return qs;
}

export function setMemberProfileLoading(message = "Loading…") {
  const text = escapeHtml(message);
  $("#member-proof-list").innerHTML = `<p class="member-empty">${text}</p>`;
  $("#member-tickets-list").innerHTML = `<p class="member-empty">${text}</p>`;
  setMemberPanelCountsLoading();
}

export function renderMemberProfileHeader() {
  const { memberId, from, to } = state.memberProfile;
  const member = memberById(memberId);
  const profile = state.memberProfile.profile;
  const name = member?.name || memberId || "—";
  const hero = $("#member-profile-hero");
  if (hero) {
    const headline = String(profile?.headline || "").trim();
    const bio = String(profile?.bio || "").trim();
    hero.innerHTML = `
      <div class="bio-hero-avatar">${renderAvatar({ name, avatarUrl: profile?.avatar?.url, size: "xl" })}</div>
      <div class="bio-hero-body">
        <h2 class="bio-hero-name">${escapeHtml(name)}</h2>
        ${headline ? `<p class="bio-hero-headline">${escapeHtml(headline)}</p>` : ""}
        <p class="bio-hero-meta">${escapeHtml(buildMemberMeta(member, memberId))}</p>
        ${bio ? `<p class="bio-hero-bio">${escapeHtml(bio)}</p>` : ""}
      </div>
    `;
  }
  const rangeLabel = $("#member-profile-range-label");
  if (rangeLabel) rangeLabel.textContent = from && to
    ? `Showing submissions and tickets from ${fmtDateHuman(from)} to ${fmtDateHuman(to)} (UTC)`
    : "All available submissions and ticket history";
  const fromInput = $("#member-from");
  const toInput = $("#member-to");
  if (fromInput) fromInput.value = from;
  if (toInput) toInput.value = to;
}

function buildMemberMeta(member, memberId) {
  if (!member) return memberId ? `Unknown member id: ${memberId}` : "—";
  const pieces = [fmtShiftLabel(member), member.registered ? "Registered" : "Not registered"];
  if (member.telegram_username) pieces.push(`@${member.telegram_username}`);
  return pieces.filter(Boolean).join(" · ");
}

export function renderMemberProfileProof(rows) {
  const container = $("#member-proof-list");
  if (!rows.length) {
    container.innerHTML = '<p class="member-empty">No proof of work submissions in this date range.</p>';
    return;
  }
  const sorted = rows.slice().sort((a, b) => String(b.submitted_at_utc || "").localeCompare(String(a.submitted_at_utc || "")));
  container.innerHTML = `<div class="member-proof-list">${sorted.map((row) => renderProofCard(row, { showMember: false })).join("")}</div>`;
}

function renderMemberTickets(rows) {
  const container = $("#member-tickets-list");
  if (!rows.length) {
    container.innerHTML = '<p class="member-empty">No support tickets assigned to this member in the selected date range.</p>';
    return;
  }
  const sorted = rows.slice().sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
  container.innerHTML = `<div class="member-ticket-list">${sorted.map((ticket) => {
    const code = ticket.ticket_code || String(ticket.id || "").slice(0, 8) || "—";
    const statusLabel = TICKET_STATUS_LABEL[ticket.status] || ticket.status || "Unknown";
    const statusPill = pill(TICKET_STATUS_PILL[ticket.status] || "pill-slate", statusLabel);
    const messages = Array.isArray(ticket.messages) ? ticket.messages : [];
    const group = ticket.group_title || (ticket.telegram_chat_id ? `Chat ${ticket.telegram_chat_id}` : "—");
    const responder = ticket.assigned_member_name || ticket.scheduled_member_name || ticket.covered_for_member_name || "Unassigned";
    return `
      <article class="member-ticket-card">
        <div class="member-ticket-topline">
          <div>
            <h4 class="member-ticket-code">#${escapeHtml(code)}</h4>
            <p class="member-ticket-meta">${escapeHtml(ticket.opened_by_name || "Unknown requester")} · ${escapeHtml(fmtTimeUtc(ticket.created_at))}</p>
          </div>
          ${statusPill}
        </div>
        <p class="member-ticket-assignment">${escapeHtml(group)} · Responder: ${escapeHtml(responder)}</p>
        <details class="member-ticket-details">
          <summary>View ticket content and conversation (${messages.length} messages)</summary>
          <div class="member-ticket-content">
            <div class="member-ticket-original">
              <div class="member-ticket-content-label">Original user message</div>
              <p>${escapeHtml(ticket.opened_message_text || "No original message recorded.")}</p>
            </div>
            <div class="member-ticket-content-label">Conversation history</div>
            ${renderTicketMessages(ticket)}
          </div>
        </details>
      </article>
    `;
  }).join("")}</div>`;
}

async function loadMemberProofRows(target, force = false) {
  if (!force && state.memberProfile.proofLoaded) return;
  const container = $("#member-proof-list");
  container.innerHTML = '<p class="member-empty">Loading Proof of Work submissions…</p>';
  try {
    const data = await fetchJson(`/api/web/proof-submissions?${buildProofQuery(target).toString()}`);
    if (!isCurrentProfile(target)) return;
    state.memberProfile.proof = data.submissions || [];
    state.memberProfile.proofCount = Number.isFinite(Number(data.count)) ? Number(data.count) : state.memberProfile.proof.length;
    state.memberProfile.proofLoaded = true;
    updatePanelButton("proof");
    renderMemberProfileProof(state.memberProfile.proof);
  } catch (error) {
    if (!isCurrentProfile(target)) return;
    state.memberProfile.proofLoaded = false;
    container.innerHTML = `<p class="member-load-error">Unable to load Proof of Work submissions: ${escapeHtml(error.message || "Unknown error")}</p>`;
  }
}

async function loadMemberTicketRows(target, force = false) {
  if (!force && state.memberProfile.ticketsLoaded) return;
  const container = $("#member-tickets-list");
  container.innerHTML = '<p class="member-empty">Loading tickets and conversations…</p>';
  try {
    const data = await fetchJson(`/api/web/support-tickets?${buildTicketQuery(target).toString()}`);
    if (!isCurrentProfile(target)) return;
    state.memberProfile.tickets = data.tickets || [];
    state.memberProfile.ticketsCount = Number.isFinite(Number(data.count)) ? Number(data.count) : state.memberProfile.tickets.length;
    state.memberProfile.ticketsLoaded = true;
    updatePanelButton("tickets");
    renderMemberTickets(state.memberProfile.tickets);
  } catch (error) {
    if (!isCurrentProfile(target)) return;
    state.memberProfile.ticketsLoaded = false;
    container.innerHTML = `<p class="member-load-error">Unable to load tickets: ${escapeHtml(error.message || "Unknown error")}</p>`;
  }
}

async function toggleMemberPanel(kind) {
  const isProof = kind === "proof";
  const currentlyOpen = Boolean(state.memberProfile[isProof ? "proofOpen" : "ticketsOpen"]);
  const shouldOpen = !currentlyOpen;
  setPanelOpen(kind, shouldOpen);
  if (!shouldOpen || !state.memberProfile.memberId) return;
  const target = {
    memberId: state.memberProfile.memberId,
    from: state.memberProfile.from,
    to: state.memberProfile.to
  };
  if (isProof) await loadMemberProofRows(target);
  else await loadMemberTicketRows(target);
}

export function initMemberProfileControls() {
  $("#member-proof-toggle").addEventListener("click", () => { void toggleMemberPanel("proof"); });
  $("#member-tickets-toggle").addEventListener("click", () => { void toggleMemberPanel("tickets"); });
}

export async function loadMemberProfile() {
  const { memberId, from, to } = state.memberProfile;
  if (!memberId) {
    setMemberProfileLoading("Pick a member to view their Proof of Work and tickets.");
    return;
  }

  const target = { memberId, from, to };
  const dataKey = `${memberId}|${from}|${to}`;
  if (state.memberProfile.dataKey !== dataKey) {
    state.memberProfile.dataKey = dataKey;
    state.memberProfile.proof = [];
    state.memberProfile.tickets = [];
    state.memberProfile.proofLoaded = false;
    state.memberProfile.ticketsLoaded = false;
    state.memberProfile.proofCount = null;
    state.memberProfile.ticketsCount = null;
    $("#member-proof-list").innerHTML = '<p class="member-empty">Click Proof of Work to load submissions.</p>';
    $("#member-tickets-list").innerHTML = '<p class="member-empty">Click Tickets to load this member’s ticket history.</p>';
  }

  renderMemberProfileHeader();
  updatePanelButton("proof");
  updatePanelButton("tickets");
  state.memberProfile.loading = true;
  const token = ++profileLoadToken;
  const proofCountQuery = buildProofQuery(target, true);
  const ticketCountQuery = buildTicketQuery(target, true);

  try {
    const [profile, proofCount, ticketCount] = await Promise.all([
      fetchJson(`/api/web/members?member_id=${encodeURIComponent(memberId)}`).catch((error) => ({ error })),
      fetchJson(`/api/web/proof-submissions?${proofCountQuery.toString()}`).catch((error) => ({ error })),
      fetchJson(`/api/web/support-tickets?${ticketCountQuery.toString()}`).catch((error) => ({ error }))
    ]);
    if (token !== profileLoadToken || !isCurrentProfile(target)) return;

    state.memberProfile.profile = profile.error ? null : (profile.profile || null);
    renderMemberProfileHeader();
    state.memberProfile.proofCount = proofCount.error
      ? "unavailable"
      : (Number.isFinite(Number(proofCount.count)) ? Number(proofCount.count) : 0);
    state.memberProfile.ticketsCount = ticketCount.error
      ? "unavailable"
      : (Number.isFinite(Number(ticketCount.count)) ? Number(ticketCount.count) : 0);
    updatePanelButton("proof");
    updatePanelButton("tickets");

    const openLoads = [];
    if (state.memberProfile.proofOpen) openLoads.push(loadMemberProofRows(target, true));
    if (state.memberProfile.ticketsOpen) openLoads.push(loadMemberTicketRows(target, true));
    await Promise.all(openLoads);
  } finally {
    if (token === profileLoadToken) state.memberProfile.loading = false;
  }
}

export function openMemberProfile(memberId, opts = {}) {
  const range = opts.from && opts.to ? { from: opts.from, to: opts.to } : defaultMemberRange();
  profileLoadToken += 1;
  state.memberProfile.memberId = memberId;
  state.memberProfile.from = range.from;
  state.memberProfile.to = range.to;
  state.memberProfile.view = "";
  state.memberProfile.profile = null;
  state.memberProfile.dataKey = "";
  state.memberProfile.proof = [];
  state.memberProfile.tickets = [];
  state.memberProfile.proofLoaded = false;
  state.memberProfile.ticketsLoaded = false;
  state.memberProfile.proofCount = null;
  state.memberProfile.ticketsCount = null;
  setPanelOpen("proof", false);
  setPanelOpen("tickets", false);
  $("#member-proof-list").innerHTML = '<p class="member-empty">Click Proof of Work to load submissions.</p>';
  $("#member-tickets-list").innerHTML = '<p class="member-empty">Click Tickets to load this member’s ticket history.</p>';
  updateMemberUrlParams({ memberId, from: range.from, to: range.to, replace: Boolean(opts.replace) });
  showMemberTabButton(true);
  switchTab("member");
}

export function showMemberTabButton(visible) {
  const btn = $("#member-tab-btn");
  if (btn) btn.classList.toggle("hidden", !visible);
}

export function buildMemberShareLink() {
  const { memberId, from, to } = state.memberProfile;
  if (!memberId) return "";
  const url = new URL(window.location.href);
  url.searchParams.set("member", memberId);
  if (from) url.searchParams.set("from", from); else url.searchParams.delete("from");
  if (to) url.searchParams.set("to", to); else url.searchParams.delete("to");
  url.searchParams.delete("view");
  url.searchParams.delete("issue");
  url.hash = "";
  return url.toString();
}
