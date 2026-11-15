// Working Management — read-only dashboard SPA
// Plain ES module served from /public; no build step required.


import { renderActivity } from "./activity.js";
import { initTelegramAuth, onIdentityChange } from "./auth.js";
import { loadCommunitySummary } from "./community-summary.js";
import { loadIssueCategories, normalizeIssueCategory } from "./issue-categories.js";
import { defaultIssueRange, getIssueUrlParams, loadIssueReport, openIssueReport, updateIssueUrlParams } from "./issue-report.js";
import { closeMemberDetail, openMemberDetail } from "./member-detail.js";
import { defaultMemberRange, getMemberUrlParams, initMemberProfileControls, loadMemberProfile, openMemberProfile, renderMemberProfileHeader, showMemberTabButton, updateMemberUrlParams } from "./member-profile.js";
import { loadMembers } from "./members.js";
import { initPages, loadPages, openPageByToken, renderSharedPage } from "./pages.js";
import { loadProof } from "./proof.js";
import { initProofReports } from "./proof-reports.js";
import { state } from "./state.js";
import { loadStats, setStatsGrouping } from "./stats.js";
import { initDefaultDates, refreshCurrent, switchTab, toggleWeek } from "./tabs.js";
import { loadTicketSearch, loadTickets, renderTicketSearch, renderTickets } from "./tickets.js";
import { $, $all, copyTextToButton, debounce, memberLink, wireSorting } from "./utils.js";

export async function init() {
  initDefaultDates();
  initPages();
  // The Pages tab only makes sense for a signed-in member; it appears and
  // disappears with the Telegram login.
  const pagesTab = $("#pages-tab-btn");
  const homePagesBtn = $("#home-pages-btn");
  onIdentityChange((name) => {
    pagesTab?.classList.toggle("hidden", !name);
    homePagesBtn?.classList.toggle("hidden", !name);
    if (!name && state.currentTab === "pages") switchTab("home");
    // Opening Pages before the Telegram login lands fails with 401, and nothing
    // used to retry, so the sidebar stayed on its error until another action.
    // Reload once the session arrives.
    if (name && !state.pages.loaded) loadPages().catch(() => {});
  });
  initTelegramAuth();
  $("#activity-member").setAttribute("data-members-select", "1");
  $("#proof-member").setAttribute("data-members-select", "1");
  $("#tickets-assigned-member").setAttribute("data-members-select", "1");
  $("#tickets-scheduled-member").setAttribute("data-members-select", "1");
  $("#ticket-search-member").setAttribute("data-members-select", "1");

  // Kick off the two startup fetches without awaiting them: neither is needed to
  // wire the UI, and the tab buttons were dead until both finished. They run in
  // parallel now, and the initial route is resolved right after the listeners are
  // attached so the shell paints and responds immediately.
  const membersReady = loadMembers().catch((error) => {
    console.warn("Failed to load members", error);
  });
  const categoriesReady = loadIssueCategories().catch((error) => {
    console.warn("Failed to load issue categories", error);
  });

  // Tabs
  for (const btn of $all(".tab-btn")) {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  }
  for (const btn of $all("[data-menu-tab]")) {
    btn.addEventListener("click", () => switchTab(btn.dataset.menuTab));
  }
  initProofReports();
  initMemberProfileControls();
  $("#refresh-btn").addEventListener("click", refreshCurrent);
  // Pages is reachable from the home directory once signed in, because the
  // welcome flow hides the tab bar. From inside Pages, Home goes back.
  $("#home-pages-btn")?.addEventListener("click", () => switchTab("pages"));
  $("#pages-back-home")?.addEventListener("click", () => switchTab("home"));
  $("#proof-reports-copy-link").addEventListener("click", () => {
    const reportUrl = new URL(window.location.href);
    reportUrl.search = "";
    reportUrl.searchParams.set("reports", "1");
    copyTextToButton(reportUrl.href, $("#proof-reports-copy-link"));
  });
  $("#home-continue").addEventListener("click", () => {
    document.body.dataset.homeContinued = "true";
    document.body.classList.add("member-review-flow");
    document.body.classList.remove("home-welcome-mode");
    $("#home-welcome").classList.add("hidden");
    const directory = $("#home-directory");
    directory.classList.remove("hidden");
    directory.scrollIntoView({ behavior: "smooth", block: "start" });
  });
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

  // Resolve the initial route without holding the first screen behind background
  // requests. Home, reports and public page links can render immediately; only
  // member-dependent deep links wait for the member directory they render from.
  const initialIssue = getIssueUrlParams();
  const initialUrl = getMemberUrlParams();
  const initialReports = new URLSearchParams(window.location.search).get("reports") === "1";
  const initialShareToken = new URLSearchParams(window.location.search).get("page");
  const searchParams = new URLSearchParams(window.location.search);
  const hasIssueQuery = Boolean(searchParams.get("issue") || searchParams.get("category"));
  const resolveInitialRoute = async () => {
    if (initialShareToken) {
      // A page share link opens the page by itself, with no login and no sidebar.
      document.body.dataset.homeContinued = "true";
      openPageByToken(initialShareToken)
        .then(() => { renderSharedPage(); switchTab("pages-shared"); })
        .catch(() => { renderSharedPage(); switchTab("pages-shared"); });
    } else {
      // Issue links use the canonical category list; defer only that deep link,
      // never the ordinary Home screen, until the category request completes.
      const issue = hasIssueQuery ? await categoriesReady.then(getIssueUrlParams) : initialIssue;
      if (issue.category) {
        await membersReady;
        const range = (issue.from && issue.to)
          ? { from: issue.from, to: issue.to }
          : defaultIssueRange();
        state.issueReport.category = issue.category;
        state.issueReport.from = range.from;
        state.issueReport.to = range.to;
        if (!issue.from || !issue.to) {
          updateIssueUrlParams({
            category: issue.category,
            from: range.from,
            to: range.to,
            replace: true
          });
        }
        switchTab("issue-report");
      } else if (initialUrl.memberId) {
        await membersReady;
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
      } else if (initialReports) {
        // ?reports=1 opens the dashboard archive without changing the clean member-review flow.
        document.body.dataset.homeContinued = "true";
        switchTab("proof");
      } else {
        switchTab("home");
      }
    }
  };
  resolveInitialRoute().catch((error) => console.error("Failed to resolve initial route", error));
  setInterval(refreshCurrent, 60_000);
}

init();
