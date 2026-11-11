import { loadActivity, renderActivity } from "./activity.js";
import { loadCommunitySummary } from "./community-summary.js";
import { loadIssueReport, updateIssueUrlParams } from "./issue-report.js";
import { loadMemberProfile, showMemberTabButton, updateMemberUrlParams } from "./member-profile.js";
import { loadProof, renderProof } from "./proof.js";
import { loadProofReports } from "./proof-reports.js";
import { state } from "./state.js";
import { loadStats, renderStats } from "./stats.js";
import { loadTicketSearch, loadTickets } from "./tickets.js";
import { $, $all, setLastUpdated } from "./utils.js";

export function switchTab(name) {
  const previousTab = state.currentTab;
  state.currentTab = name;
  document.body.classList.toggle("member-profile-mode", name === "member");
  document.body.classList.toggle("home-welcome-mode", name === "home" && document.body.dataset.homeContinued !== "true");
  for (const btn of $all(".tab-btn")) {
    btn.setAttribute("aria-selected", btn.dataset.tab === name ? "true" : "false");
  }
  for (const panel of $all("[data-tab-panel]")) {
    panel.classList.toggle("active", panel.dataset.tabPanel === name);
  }
  // Leaving the member page always clears its state; updateMemberUrlParams keeps
  // the shared from/to window when the issue report now owns it.
  if (name !== "member" && previousTab === "member") {
    state.memberProfile.memberId = null;
    state.memberProfile.view = "";
    updateMemberUrlParams({ memberId: null });
    showMemberTabButton(false);
  }
  if (name !== "issue-report" && previousTab === "issue-report") {
    updateIssueUrlParams({ category: "" });
  }
  refreshCurrent();
}

export function refreshCurrent() {
  setLastUpdated();
  if (state.currentTab === "home") return;
  if (state.currentTab === "community-summary") loadCommunitySummary();
  else if (state.currentTab === "activity") loadActivity();
  else if (state.currentTab === "stats") loadStats();
  else if (state.currentTab === "proof") {
    loadProof();
    loadProofReports();
  }
  else if (state.currentTab === "tickets") loadTickets();
  else if (state.currentTab === "ticket-search") loadTicketSearch();
  else if (state.currentTab === "issue-report") loadIssueReport();
  else if (state.currentTab === "member") loadMemberProfile();
}

export function initDefaultDates() {
  const today = new Date();
  const thirtyDaysAgo = new Date(today.getTime() - 29 * 24 * 60 * 60 * 1000);
  const iso = (d) => d.toISOString().slice(0, 10);
  $("#stats-from").value = iso(thirtyDaysAgo);
  $("#stats-to").value = iso(today);
  $("#proof-from").value = iso(thirtyDaysAgo);
  $("#proof-to").value = iso(today);
  $("#tickets-from").value = iso(thirtyDaysAgo);
  $("#tickets-to").value = iso(today);
}

export function toggleWeek(section, key) {
  const target =
    section === "activity" ? state.activity.expandedWeeks :
    section === "stats" ? state.stats.expandedWeeks :
    section === "proof" ? state.proof.expandedWeeks :
    null;
  if (!target) return;
  if (target.has(key)) target.delete(key);
  else target.add(key);
  if (section === "activity") renderActivity();
  else if (section === "stats") renderStats();
  else if (section === "proof") renderProof();
}
