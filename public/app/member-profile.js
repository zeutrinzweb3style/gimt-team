import { fmtShiftLabel, memberById } from "./members.js";
import { renderProofCard } from "./proof.js";
import { renderAvatar } from "./profile.js";
import { state } from "./state.js";
import { switchTab } from "./tabs.js";
import { $, escapeHtml, fetchJson, fmtDateHuman, toIsoDate } from "./utils.js";

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

export function setMemberProfileLoading(message = "Loading…") {
  $("#member-proof-list").innerHTML = `<p class="member-empty">${escapeHtml(message)}</p>`;
  $("#member-proof-count").textContent = "…";
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
    ? `Showing submissions from ${fmtDateHuman(from)} to ${fmtDateHuman(to)} (UTC)`
    : "All available submissions";
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
  $("#member-proof-count").textContent = `${rows.length} submission${rows.length === 1 ? "" : "s"}`;
  if (!rows.length) {
    container.innerHTML = '<p class="member-empty">No proof of work submissions in this date range.</p>';
    return;
  }
  const sorted = rows.slice().sort((a, b) => String(b.submitted_at_utc || "").localeCompare(String(a.submitted_at_utc || "")));
  container.innerHTML = `<div class="member-proof-list">${sorted.map((row) => renderProofCard(row, { showMember: false })).join("")}</div>`;
}

export async function loadMemberProfile() {
  const { memberId, from, to } = state.memberProfile;
  if (!memberId) {
    setMemberProfileLoading("Pick a member to see their proof of work.");
    return;
  }
  renderMemberProfileHeader();
  setMemberProfileLoading();
  state.memberProfile.loading = true;
  const proofQs = new URLSearchParams({ limit: "500", member_id: memberId });
  if (from) proofQs.set("from", from);
  if (to) proofQs.set("to", to);
  try {
    const [profile, proof] = await Promise.all([
      fetchJson(`/api/web/members?member_id=${encodeURIComponent(memberId)}`).catch((error) => ({ error })),
      fetchJson(`/api/web/proof-submissions?${proofQs.toString()}`).catch((error) => ({ error }))
    ]);
    state.memberProfile.profile = profile.error ? null : (profile.profile || null);
    renderMemberProfileHeader();
    if (proof.error) {
      $("#member-proof-list").innerHTML = `<p class="member-load-error">Unable to load proof of work: ${escapeHtml(proof.error.message || "Unknown error")}</p>`;
      $("#member-proof-count").textContent = "Unavailable";
    } else {
      state.memberProfile.proof = proof.submissions || [];
      renderMemberProfileProof(state.memberProfile.proof);
    }
  } finally {
    state.memberProfile.loading = false;
  }
}

export function openMemberProfile(memberId, opts = {}) {
  const range = opts.from && opts.to ? { from: opts.from, to: opts.to } : defaultMemberRange();
  state.memberProfile.memberId = memberId;
  state.memberProfile.from = range.from;
  state.memberProfile.to = range.to;
  state.memberProfile.view = "";
  state.memberProfile.profile = null;
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
