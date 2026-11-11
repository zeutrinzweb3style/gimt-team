// Working Management — read-only dashboard SPA
// Plain ES module served from /public; no build step required.


import { renderActivity } from "./activity.js";
import { loadCommunitySummary } from "./community-summary.js";
import { loadIssueCategories, normalizeIssueCategory } from "./issue-categories.js";
import { defaultIssueRange, getIssueUrlParams, loadIssueReport, openIssueReport, updateIssueUrlParams } from "./issue-report.js";
import { closeMemberDetail, openMemberDetail } from "./member-detail.js";
import { applyMemberProfileView, buildMemberShareLink, copyMemberShareLink, copyTextToButton, defaultMemberRange, getMemberUrlParams, loadMemberProfile, openMemberProfile, renderMemberProfileHeader, showMemberTabButton, updateMemberUrlParams } from "./member-profile.js";
import { loadMembers } from "./members.js";
import { loadProof } from "./proof.js";
import { normalizeMemberView, state } from "./state.js";
import { loadStats, setStatsGrouping } from "./stats.js";
import { initDefaultDates, refreshCurrent, switchTab, toggleWeek } from "./tabs.js";
import { loadTicketSearch, loadTickets, renderTicketSearch, renderTickets } from "./tickets.js";
import { $, $all, debounce, memberLink, wireSorting } from "./utils.js";

export async function init() {
  initDefaultDates();
  $("#activity-member").setAttribute("data-members-select", "1");
  $("#proof-member").setAttribute("data-members-select", "1");
  $("#tickets-assigned-member").setAttribute("data-members-select", "1");
  $("#tickets-scheduled-member").setAttribute("data-members-select", "1");
  $("#ticket-search-member").setAttribute("data-members-select", "1");

  try { await loadMembers(); } catch (error) { console.warn("Failed to load members", error); }
  try { await loadIssueCategories(); } catch (error) { console.warn("Failed to load issue categories", error); }

  // Tabs
  for (const btn of $all(".tab-btn")) {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  }
  for (const btn of $all("[data-menu-tab]")) {
    btn.addEventListener("click", () => switchTab(btn.dataset.menuTab));
  }
  $("#refresh-btn").addEventListener("click", refreshCurrent);
  $("#community-summary-date").addEventListener("change", loadCommunitySummary);
  $("#community-summary-refresh").addEventListener("click", loadCommunitySummary);

  // Activity filters (client-side over the loaded set)
  $("#activity-member").addEventListener("change", (e) => {
    state.activity.filters.member_id = e.target.value;
    renderActivity();
  });
  $("#activity-action").addEventListener("change", (e) => {
    state.activity.filters.action = e.target.value;
    renderActivity();
  });
  $("#activity-search").addEventListener("input", (e) => {
    state.activity.filters.search = e.target.value;
    renderActivity();
  });
  wireSorting("#activity-table", state.activity.sort, renderActivity);

  // Stats filters + grouping toggle
  $("#stats-group-filter").addEventListener("change", (e) => {
    state.stats.selectedGroupId = e.target.value;
    loadStats();
  });
  $("#stats-from").addEventListener("change", loadStats);
  $("#stats-to").addEventListener("change", loadStats);
  $("#stats-group-date").addEventListener("click", () => setStatsGrouping("date"));
  $("#stats-group-member").addEventListener("click", () => setStatsGrouping("member"));

  // Proof filters
  $("#proof-member").addEventListener("change", loadProof);
  $("#proof-from").addEventListener("change", loadProof);
  $("#proof-to").addEventListener("change", loadProof);

  // Ticket filters
  $("#tickets-assigned-member").addEventListener("change", (e) => {
    state.tickets.filters.assigned_member_id = e.target.value;
    loadTickets();
  });
  $("#tickets-scheduled-member").addEventListener("change", (e) => {
    state.tickets.filters.scheduled_member_id = e.target.value;
    loadTickets();
  });
  $("#tickets-status").addEventListener("change", (e) => {
    state.tickets.filters.status = e.target.value;
    loadTickets();
  });
  for (const button of $all(".ticket-queue-btn")) {
    button.addEventListener("click", () => {
      state.tickets.filters.status = button.dataset.ticketStatus || "";
      $("#tickets-status").value = state.tickets.filters.status;
      loadTickets();
    });
  }
  $("#tickets-group-filter").addEventListener("change", (e) => {
    state.tickets.filters.telegram_chat_id = e.target.value;
    loadTickets();
  });
  $("#tickets-from").addEventListener("change", loadTickets);
  $("#tickets-to").addEventListener("change", loadTickets);

  // Member Profile (per-member page)
  $("#member-from").addEventListener("change", (e) => {
    if (!state.memberProfile.memberId) return;
    state.memberProfile.from = e.target.value;
    updateMemberUrlParams({
      memberId: state.memberProfile.memberId,
      from: state.memberProfile.from,
      to: state.memberProfile.to,
      view: state.memberProfile.view,
      replace: true
    });
    renderMemberProfileHeader();
    loadMemberProfile();
  });
  $("#member-to").addEventListener("change", (e) => {
    if (!state.memberProfile.memberId) return;
    state.memberProfile.to = e.target.value;
    updateMemberUrlParams({
      memberId: state.memberProfile.memberId,
      from: state.memberProfile.from,
      to: state.memberProfile.to,
      view: state.memberProfile.view,
      replace: true
    });
    renderMemberProfileHeader();
    loadMemberProfile();
  });
  $("#member-copy-link").addEventListener("click", copyMemberShareLink);
  $("#member-back-btn").addEventListener("click", () => switchTab("home"));

  // Repeated issue report page (reachable at its own ?issue=... URL).
  $("#issue-category").addEventListener("change", (e) => {
    const category = normalizeIssueCategory(e.target.value);
    if (!category) {
      state.issueReport.category = "";
      updateIssueUrlParams({ category: "", replace: true });
      switchTab("tickets");
      return;
    }
    openIssueReport(category, state.issueReport.from, state.issueReport.to);
  });
  $("#issue-from").addEventListener("change", (e) => {
    state.issueReport.from = e.target.value;
    updateIssueUrlParams({
      category: state.issueReport.category,
      from: state.issueReport.from,
      to: state.issueReport.to,
      replace: true
    });
    loadIssueReport();
  });
  $("#issue-to").addEventListener("change", (e) => {
    state.issueReport.to = e.target.value;
    updateIssueUrlParams({
      category: state.issueReport.category,
      from: state.issueReport.from,
      to: state.issueReport.to,
      replace: true
    });
    loadIssueReport();
  });
  $("#issue-copy-link").addEventListener("click", () => {
    copyTextToButton(window.location.href, $("#issue-copy-link"));
  });
  $("#issue-back-btn").addEventListener("click", () => {
    updateIssueUrlParams({ category: "", replace: true });
    switchTab("tickets");
  });
  // Space/Enter should open the report when a card has focus.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const card = e.target.closest && e.target.closest("[data-issue-category]");
    if (!card) return;
    e.preventDefault();
    openIssueReport(card.dataset.issueCategory, card.dataset.issueFrom, card.dataset.issueTo);
  });

  // Per-section "copy link" buttons (Support Tickets / Proof / Activity / Stats).
  for (const btn of $all(".member-share-btn[data-share-view]")) {
    btn.addEventListener("click", () => {
      const view = normalizeMemberView(btn.dataset.shareView);
      if (!view || !state.memberProfile.memberId) return;
      copyTextToButton(buildMemberShareLink(view), btn, "Copied!");
    });
  }
  // "View full profile" inside the focused-view banner.
  $("#member-view-all").addEventListener("click", () => {
    if (!state.memberProfile.memberId) return;
    state.memberProfile.view = "";
    updateMemberUrlParams({
      memberId: state.memberProfile.memberId,
      from: state.memberProfile.from,
      to: state.memberProfile.to,
      view: "",
      replace: true
    });
    applyMemberProfileView();
  });

  window.addEventListener("popstate", () => {
    const issueParams = getIssueUrlParams();
    if (issueParams.category) {
      state.issueReport.category = issueParams.category;
      state.issueReport.from = issueParams.from;
      state.issueReport.to = issueParams.to;
      switchTab("issue-report");
      return;
    }
    const params = getMemberUrlParams();
    if (params.memberId) {
      const range = (params.from && params.to)
        ? { from: params.from, to: params.to }
        : defaultMemberRange();
      state.memberProfile.memberId = params.memberId;
      state.memberProfile.from = range.from;
      state.memberProfile.to = range.to;
      state.memberProfile.view = params.view;
      showMemberTabButton(true);
      switchTab("member");
    } else if (state.currentTab === "member") {
      state.memberProfile.memberId = null;
      state.memberProfile.view = "";
      showMemberTabButton(false);
      switchTab("home");
    }
  });

  // Ticket search filters
  const debouncedTicketSearch = debounce(loadTicketSearch);
  $("#ticket-search-query").addEventListener("input", (e) => {
    state.ticketSearch.filters.q = e.target.value.trim();
    debouncedTicketSearch();
  });
  $("#ticket-search-member").addEventListener("change", (e) => {
    state.ticketSearch.filters.member_id = e.target.value;
    loadTicketSearch();
  });
  $("#ticket-search-status").addEventListener("change", (e) => {
    state.ticketSearch.filters.status = e.target.value;
    loadTicketSearch();
  });

  // Global delegated click handler for member links + week toggles + modal close
  document.addEventListener("click", (e) => {
    // Clicking a repeated-issue card opens that issue's own report URL.
    const issueCard = e.target.closest("[data-issue-category]");
    if (issueCard) {
      // The card also contains a real link ("Open in new tab"); let the browser
      // handle that one so middle-click and copy-link still behave normally.
      if (e.target.closest("[data-issue-link]")) return;
      e.preventDefault();
      openIssueReport(issueCard.dataset.issueCategory, issueCard.dataset.issueFrom, issueCard.dataset.issueTo);
      return;
    }

    const ticketToggle = e.target.closest(".ticket-history-toggle");
    if (ticketToggle) {
      e.preventDefault();
      const id = ticketToggle.dataset.ticketId;
      const source = ticketToggle.dataset.ticketSource === "ticketSearch" ? "ticketSearch" : "tickets";
      if (id) {
        if (state[source].expandedIds.has(id)) state[source].expandedIds.delete(id);
        else state[source].expandedIds.add(id);
        if (source === "ticketSearch") renderTicketSearch();
        else renderTickets();
      }
      return;
    }

    const memberTile = e.target.closest("[data-member-tile]");
    if (memberTile) {
      e.preventDefault();
      const id = memberTile.dataset.memberTile;
      if (id) openMemberProfile(id);
      return;
    }

    const memberLink = e.target.closest(".member-link");
    if (memberLink) {
      e.preventDefault();
      const id = memberLink.dataset.memberId;
      const name = memberLink.dataset.memberName;
      if (id) openMemberDetail(id, name || id);
      return;
    }
    const weekBtn = e.target.closest(".week-toggle");
    if (weekBtn && !weekBtn.dataset.weekCurrent) {
      toggleWeek(weekBtn.dataset.weekSection, weekBtn.dataset.week);
      return;
    }
    if (e.target.closest("#member-modal-close") || e.target.classList.contains("modal-backdrop")) {
      closeMemberDetail();
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state.memberDetail.open) closeMemberDetail();
  });

  // Initial route. The issue report owns its own URL (?issue=...&from=...&to=...)
  // so a shared report link opens straight to that report.
  const initialIssue = getIssueUrlParams();
  const initialUrl = getMemberUrlParams();
  if (initialIssue.category) {
    const range = (initialIssue.from && initialIssue.to)
      ? { from: initialIssue.from, to: initialIssue.to }
      : defaultIssueRange();
    state.issueReport.category = initialIssue.category;
    state.issueReport.from = range.from;
    state.issueReport.to = range.to;
    if (!initialIssue.from || !initialIssue.to) {
      updateIssueUrlParams({
        category: initialIssue.category,
        from: range.from,
        to: range.to,
        replace: true
      });
    }
    switchTab("issue-report");
  } else if (initialUrl.memberId) {
    // ?member=... opens Member Profile directly so the shareable link works.
    const range = (initialUrl.from && initialUrl.to)
      ? { from: initialUrl.from, to: initialUrl.to }
      : defaultMemberRange();
    state.memberProfile.memberId = initialUrl.memberId;
    state.memberProfile.from = range.from;
    state.memberProfile.to = range.to;
    state.memberProfile.view = initialUrl.view;
    if (!initialUrl.from || !initialUrl.to) {
      updateMemberUrlParams({
        memberId: initialUrl.memberId,
        from: range.from,
        to: range.to,
        view: initialUrl.view,
        replace: true
      });
    }
    showMemberTabButton(true);
    switchTab("member");
  } else {
    switchTab("home");
  }
  setInterval(refreshCurrent, 60_000);
}

init();
