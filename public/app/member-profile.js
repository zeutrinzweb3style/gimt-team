import { fmtShiftLabel, memberById } from "./members.js";
import { renderProofCard } from "./proof.js";
import { renderAvatar, renderBioLinks } from "./profile.js";
import { ACTION_LABEL, ACTION_PILL, MEMBER_VIEWS, TICKET_STATUS_LABEL, TICKET_STATUS_PILL, normalizeMemberView, state } from "./state.js";
import { switchTab } from "./tabs.js";
import { renderTicketMessageAttachments, ticketDisplayCode, ticketGroupName } from "./tickets.js";
import { $, $all, escapeHtml, fetchJson, fmtDateHuman, fmtTimeUtc, groupName, pill, ticketMessageDisplayText, toIsoDate } from "./utils.js";

export function defaultMemberRange() {
  const today = new Date();
  const start = new Date(today.getTime() - 6 * 24 * 60 * 60 * 1000);
  return { from: toIsoDate(start), to: toIsoDate(today) };
}

export function getMemberUrlParams() {
  const params = new URLSearchParams(window.location.search);
  return {
    memberId: params.get("member") || "",
    from: params.get("from") || "",
    to: params.get("to") || "",
    view: normalizeMemberView(params.get("view"))
  };
}

export function updateMemberUrlParams({ memberId, from, to, view = "", replace = false }) {
  const url = new URL(window.location.href);
  if (memberId) {
    url.searchParams.set("member", memberId);
    if (from) url.searchParams.set("from", from); else url.searchParams.delete("from");
    if (to) url.searchParams.set("to", to); else url.searchParams.delete("to");
    const normalizedView = normalizeMemberView(view);
    if (normalizedView) url.searchParams.set("view", normalizedView); else url.searchParams.delete("view");
    // Issue and member routes are mutually exclusive; drop the issue params so a
    // shared link does not open two pages at once.
    url.searchParams.delete("issue");
  } else {
    url.searchParams.delete("member");
    url.searchParams.delete("view");
    // from/to are shared with the issue-report route; keep them if that route owns them.
    if (!url.searchParams.get("issue")) {
      url.searchParams.delete("from");
      url.searchParams.delete("to");
    }
  }
  const next = `${url.pathname}${url.search}${url.hash}`;
  if (replace) window.history.replaceState({}, "", next);
  else window.history.pushState({}, "", next);
}

export function setMemberProfileLoading(message = "Loading\u2026") {
  const html = `<p class="member-empty">${escapeHtml(message)}</p>`;
  $("#member-tickets-list").innerHTML = html;
  $("#member-proof-list").innerHTML = html;
  $("#member-activity-list").innerHTML = html;
  $("#member-messages-list").innerHTML = html;
  $("#member-tickets-count").textContent = "\u2026";
  $("#member-proof-count").textContent = "\u2026";
  $("#member-activity-count").textContent = "\u2026";
  $("#member-messages-count").textContent = "\u2026";
}

export function renderMemberProfileHeader() {
  const { memberId, from, to } = state.memberProfile;
  const member = memberById(memberId);
  const profile = state.memberProfile.profile;
  const name = member?.name || memberId || "\u2014";

  const hero = $("#member-profile-hero");
  if (hero) {
    const headline = String(profile?.headline || "").trim();
    const bio = String(profile?.bio || "").trim();
    hero.innerHTML = `
      <div class="bio-hero-avatar">${renderAvatar({ name, avatarUrl: profile?.avatar?.url, size: "xl" })}</div>
      <div class="bio-hero-body">
        <h2 id="member-profile-name" class="bio-hero-name">${escapeHtml(name)}</h2>
        ${headline ? `<p class="bio-hero-headline">${escapeHtml(headline)}</p>` : ""}
        <p class="bio-hero-meta">${escapeHtml(buildMemberMeta(member, memberId))}</p>
        ${bio ? `<p class="bio-hero-bio">${escapeHtml(bio)}</p>` : ""}
        ${renderBioLinks(profile?.links)}
        ${profile ? "" : '<p class="bio-hero-empty">No profile details yet. The member can add a photo, headline, bio, and links from the bot\'s 👤 My Profile button.</p>'}
      </div>
    `;
  }

  const nameEl = $("#member-profile-name");
  if (nameEl) nameEl.textContent = name;

  const metaEl = $("#member-profile-meta");
  if (metaEl) metaEl.textContent = buildMemberMeta(member, memberId);

  $("#member-profile-range-label").textContent =
    from && to ? `Showing data from ${fmtDateHuman(from)} to ${fmtDateHuman(to)} (UTC)` : "\u2014";
  $("#member-from").value = from;
  $("#member-to").value = to;
  applyMemberProfileView();
}

function buildMemberMeta(member, memberId) {
  const metaPieces = [];
  if (member) {
    metaPieces.push(fmtShiftLabel(member));
    if (member.registered) metaPieces.push("Registered");
    else metaPieces.push("Not registered");
    if (member.telegram_username) metaPieces.push(`@${member.telegram_username}`);
  } else if (memberId) {
    metaPieces.push(`Unknown member id: ${memberId}`);
  }
  return metaPieces.filter(Boolean).join(" \u00b7 ") || "\u2014";
}

// Show only the section matching the active ?view=, or all sections when none.
export function applyMemberProfileView() {
  const view = normalizeMemberView(state.memberProfile.view);
  const activeSection = view ? MEMBER_VIEWS[view].section : "";
  for (const section of $all("[data-member-section]")) {
    const match = !activeSection || section.dataset.memberSection === activeSection;
    section.classList.toggle("hidden", !match);
  }
  const banner = $("#member-focus-banner");
  const label = $("#member-focus-label");
  if (banner && label) {
    if (view) {
      label.textContent = MEMBER_VIEWS[view].label;
      banner.classList.remove("hidden");
    } else {
      banner.classList.add("hidden");
    }
  }
  for (const btn of $all(".member-share-btn[data-share-view]")) {
    btn.classList.toggle("is-active", btn.dataset.shareView === view);
  }
  const anchorBar = $(".member-anchor-bar");
  if (anchorBar) anchorBar.classList.toggle("hidden", Boolean(view));
}

export function renderMemberProfileTickets(rows) {
  const container = $("#member-tickets-list");
  $("#member-tickets-count").textContent = String(rows.length);
  if (!rows.length) {
    container.innerHTML = '<p class="member-empty">No support tickets in this date range.</p>';
    return;
  }
  container.innerHTML = rows
    .map((ticket) => {
      const code = ticketDisplayCode(ticket);
      const status = pill(TICKET_STATUS_PILL[ticket.status] || "pill-slate", TICKET_STATUS_LABEL[ticket.status] || ticket.status);
      const opened = fmtTimeUtc(ticket.created_at);
      const closed = ticket.closed_at ? fmtTimeUtc(ticket.closed_at) : "";
      const messages = ticket.messages || [];
      const roleHints = [];
      if (ticket.assigned_member_id === state.memberProfile.memberId) roleHints.push("Assigned to this member");
      if (ticket.scheduled_member_id === state.memberProfile.memberId) roleHints.push("Scheduled duty");
      if (ticket.covered_for_member_id === state.memberProfile.memberId) roleHints.push("Covered shift handler");
      return `
        <article class="member-ticket-card">
          <header class="member-ticket-header">
            <div>
              <div class="member-ticket-code">#${escapeHtml(code)} \u00b7 ${escapeHtml(ticketGroupName(ticket))}</div>
              <div class="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                Opened ${escapeHtml(opened)} by <strong>${escapeHtml(ticket.opened_by_name)}</strong>
                ${closed ? ` \u00b7 Closed ${escapeHtml(closed)}` : ""}
              </div>
              ${roleHints.length ? `<div class="text-[11px] text-teal-700 dark:text-teal-300 mt-1">${escapeHtml(roleHints.join(" \u00b7 "))}</div>` : ""}
            </div>
            <div>${status}</div>
          </header>
          <div class="mt-2 text-sm text-slate-700 dark:text-slate-200 whitespace-pre-wrap break-words">${escapeHtml(ticket.opened_message_text)}</div>
          ${messages.length ? `
            <details class="mt-3">
              <summary class="cursor-pointer text-xs font-semibold uppercase tracking-wide text-teal-700 dark:text-teal-300">View full conversation (${messages.length} message${messages.length === 1 ? "" : "s"})</summary>
              <div class="mt-2">
                ${messages.map((message) => `
                  <div class="member-message">
                    <div class="member-message-meta">
                      <span><strong>${escapeHtml(message.sender_name)}</strong> \u00b7 ${escapeHtml(message.sender_type)}</span>
                      <span class="mono">${escapeHtml(fmtTimeUtc(message.message_date_utc))}</span>
                    </div>
                    <div class="whitespace-pre-wrap break-words">${escapeHtml(ticketMessageDisplayText(message.message_text))}</div>
                    ${renderTicketMessageAttachments(message)}
                  </div>
                `).join("")}
              </div>
            </details>
          ` : '<p class="text-xs text-slate-500 dark:text-slate-400 mt-2">No follow-up messages recorded.</p>'}
        </article>
      `;
    })
    .join("");
}

export function renderMemberProfileProof(rows) {
  const container = $("#member-proof-list");
  $("#member-proof-count").textContent = String(rows.length);
  if (!rows.length) {
    container.innerHTML = '<p class="member-empty">No proof of work submissions in this date range.</p>';
    return;
  }
  const sorted = rows.slice().sort((a, b) => String(b.submitted_at_utc || "").localeCompare(String(a.submitted_at_utc || "")));
  container.innerHTML = `<div class="space-y-2">${sorted.map(renderProofCard).join("")}</div>`;
}

export function renderMemberProfileActivity(rows) {
  const container = $("#member-activity-list");
  $("#member-activity-count").textContent = String(rows.length);
  if (!rows.length) {
    container.innerHTML = '<p class="member-empty">No activity entries in this date range.</p>';
    return;
  }
  container.innerHTML = `
    <div class="space-y-1.5">
      ${rows.map((row) => {
        const label = ACTION_LABEL[row.action] || row.action;
        const pillCls = ACTION_PILL[row.action] || "pill-slate";
        return `
          <div class="flex items-start gap-2 text-sm">
            <span class="mono text-xs text-slate-500 dark:text-slate-400 whitespace-nowrap pt-0.5">${escapeHtml(fmtTimeUtc(row.created_at))}</span>
            ${pill(pillCls, label)}
            <span class="text-slate-700 dark:text-slate-200 break-words">${escapeHtml(row.message || "")}</span>
          </div>
        `;
      }).join("")}
    </div>
  `;
}

export function renderMemberProfileMessages(rows) {
  const container = $("#member-messages-list");
  $("#member-messages-count").textContent = String(rows.length);
  if (!rows.length) {
    container.innerHTML = '<p class="member-empty">No group message activity in this date range.</p>';
    return;
  }
  const total = rows.reduce((sum, r) => sum + (r.message_count || 0), 0);
  const max = Math.max(...rows.map((r) => r.message_count || 0), 1);
  const sorted = rows.slice().sort((a, b) => String(b.work_date_utc || "").localeCompare(String(a.work_date_utc || "")));
  container.innerHTML = `
    <div class="mb-2 text-sm text-slate-600 dark:text-slate-300"><span class="mono">${total}</span> total messages across <span class="mono">${rows.length}</span> day/group row${rows.length === 1 ? "" : "s"}</div>
    <div class="space-y-0.5">
      ${sorted.map((row) => {
        const pct = Math.round(((row.message_count || 0) / max) * 100);
        return `
          <div class="sparkline-row">
            <span class="spark-date">${escapeHtml(fmtDateHuman(row.work_date_utc))} \u00b7 ${escapeHtml(groupName(row))}</span>
            <div class="spark-bar"><div class="spark-fill" style="width:${pct}%"></div></div>
            <span class="spark-count">${row.message_count}</span>
          </div>
        `;
      }).join("")}
    </div>
  `;
}

export function filterActivityByDate(rows, from, to) {
  if (!from && !to) return rows;
  const fromTs = from ? Date.parse(`${from}T00:00:00.000Z`) : -Infinity;
  const toTs = to ? Date.parse(`${to}T23:59:59.999Z`) : Infinity;
  return rows.filter((row) => {
    const ts = Date.parse(row.created_at);
    if (!Number.isFinite(ts)) return true;
    return ts >= fromTs && ts <= toTs;
  });
}

export async function loadMemberProfile() {
  const { memberId, from, to } = state.memberProfile;
  if (!memberId) {
    setMemberProfileLoading("Pick a member to see their dedicated page.");
    return;
  }
  renderMemberProfileHeader();
  setMemberProfileLoading("Loading\u2026");
  state.memberProfile.loading = true;

  const ticketsQs = new URLSearchParams({ limit: "500", member_id: memberId });
  if (from) ticketsQs.set("from", from);
  if (to) ticketsQs.set("to", to);

  const proofQs = new URLSearchParams({ limit: "500", member_id: memberId });
  if (from) proofQs.set("from", from);
  if (to) proofQs.set("to", to);

  const activityQs = new URLSearchParams({ limit: "200", member_id: memberId });

  const statsQs = new URLSearchParams({ limit: "1000", member_id: memberId });
  if (from) statsQs.set("from", from);
  if (to) statsQs.set("to", to);

  try {
    const [profile, tickets, proof, activity, stats] = await Promise.all([
      fetchJson(`/api/web/profiles?member_id=${encodeURIComponent(memberId)}`).catch((err) => ({ error: err })),
      fetchJson(`/api/web/support-tickets?${ticketsQs.toString()}`).catch((err) => ({ error: err })),
      fetchJson(`/api/web/proof-submissions?${proofQs.toString()}`).catch((err) => ({ error: err })),
      fetchJson(`/api/web/activity?${activityQs.toString()}`).catch((err) => ({ error: err })),
      fetchJson(`/api/web/group-stats?${statsQs.toString()}`).catch((err) => ({ error: err }))
    ]);

    state.memberProfile.profile = profile.error ? null : (profile.profile || null);
    renderMemberProfileHeader();

    if (tickets.error) {
      $("#member-tickets-list").innerHTML = `<p class="text-sm text-red-600 dark:text-red-400">Failed: ${escapeHtml(tickets.error.message || "Unknown error")}</p>`;
      $("#member-tickets-count").textContent = "!";
    } else {
      state.memberProfile.tickets = tickets.tickets || [];
      renderMemberProfileTickets(state.memberProfile.tickets);
    }

    if (proof.error) {
      $("#member-proof-list").innerHTML = `<p class="text-sm text-red-600 dark:text-red-400">Failed: ${escapeHtml(proof.error.message || "Unknown error")}</p>`;
      $("#member-proof-count").textContent = "!";
    } else {
      state.memberProfile.proof = proof.submissions || [];
      renderMemberProfileProof(state.memberProfile.proof);
    }

    if (activity.error) {
      $("#member-activity-list").innerHTML = `<p class="text-sm text-red-600 dark:text-red-400">Failed: ${escapeHtml(activity.error.message || "Unknown error")}</p>`;
      $("#member-activity-count").textContent = "!";
    } else {
      const filteredActivity = filterActivityByDate(activity.activities || [], from, to);
      state.memberProfile.activity = filteredActivity;
      renderMemberProfileActivity(filteredActivity);
    }

    if (stats.error) {
      $("#member-messages-list").innerHTML = `<p class="text-sm text-red-600 dark:text-red-400">Failed: ${escapeHtml(stats.error.message || "Unknown error")}</p>`;
      $("#member-messages-count").textContent = "!";
    } else {
      state.memberProfile.groupStats = stats.group_stats || [];
      renderMemberProfileMessages(state.memberProfile.groupStats);
    }
  } finally {
    state.memberProfile.loading = false;
  }
}

export function openMemberProfile(memberId, opts = {}) {
  const range = (opts.from && opts.to)
    ? { from: opts.from, to: opts.to }
    : defaultMemberRange();
  const view = normalizeMemberView(opts.view);
  state.memberProfile.memberId = memberId;
  state.memberProfile.from = range.from;
  state.memberProfile.to = range.to;
  state.memberProfile.view = view;
  state.memberProfile.profile = null;
  updateMemberUrlParams({ memberId, from: range.from, to: range.to, view, replace: Boolean(opts.replace) });
  showMemberTabButton(true);
  switchTab("member");
}

export function showMemberTabButton(visible) {
  const btn = $("#member-tab-btn");
  if (!btn) return;
  btn.classList.toggle("hidden", !visible);
}

// Build an absolute member link. Pass a MEMBER_VIEWS key to scope it to a single
// section (Discourse-ready), or "" for the full profile.
export function buildMemberShareLink(view = "") {
  const { memberId, from, to } = state.memberProfile;
  if (!memberId) return "";
  const url = new URL(window.location.href);
  url.searchParams.set("member", memberId);
  if (from) url.searchParams.set("from", from); else url.searchParams.delete("from");
  if (to) url.searchParams.set("to", to); else url.searchParams.delete("to");
  const normalizedView = normalizeMemberView(view);
  if (normalizedView) url.searchParams.set("view", normalizedView); else url.searchParams.delete("view");
  url.hash = "";
  return url.toString();
}

export function copyTextToButton(link, btn, successText = "Link copied!") {
  if (!link) return;
  const originalText = btn?.textContent || "Copy link";
  const onDone = (ok) => {
    if (!btn) return;
    btn.textContent = ok ? successText : "Copy failed";
    setTimeout(() => { btn.textContent = originalText; }, 2000);
  };
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(link).then(() => onDone(true), () => fallbackCopy(link, onDone));
  } else {
    fallbackCopy(link, onDone);
  }
}

export function copyMemberShareLink() {
  copyTextToButton(buildMemberShareLink(""), $("#member-copy-link"));
}

export function fallbackCopy(text, onDone) {
  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(textarea);
    onDone(ok);
  } catch (e) {
    onDone(false);
  }
}
