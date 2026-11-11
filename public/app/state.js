export const ACTION_LABEL = {
  time_in: "Time In",
  time_out: "Time Out",
  proof_submitted: "Proof Submitted",
  proof_reminder_sent: "Proof Reminder",
  excuse_requested: "Excuse Requested",
  absent_requested: "Absent Requested",
  shift_swap_requested: "Shift Swap Requested",
  shift_swap_response: "Shift Swap Response",
  registered: "Registered",
  PROFILE_UPDATED: "Profile Updated",
  REPEATED_ISSUE_REPORT: "Repeated Issue Report",
  DAILY_REPORT: "Daily Report"
};

export const ACTION_PILL = {
  time_in: "pill-green",
  time_out: "pill-blue",
  proof_submitted: "pill-green",
  proof_reminder_sent: "pill-yellow",
  excuse_requested: "pill-yellow",
  absent_requested: "pill-red",
  shift_swap_requested: "pill-slate",
  shift_swap_response: "pill-slate",
  registered: "pill-slate",
  PROFILE_UPDATED: "pill-blue",
  REPEATED_ISSUE_REPORT: "pill-blue",
  DAILY_REPORT: "pill-blue"
};

export const PROOF_STATUS_PILL = {
  submitted: "pill-green",
  pending: "pill-yellow",
  failed: "pill-red"
};

export const TICKET_STATUS_PILL = {
  open: "pill-yellow",
  accepted: "pill-blue",
  pending_user_resolution: "pill-yellow",
  pending_follow_up: "pill-yellow",
  solved_closed: "pill-green",
  not_solved_closed: "pill-red",
  closed_by_team: "pill-slate",
  expired: "pill-slate"
};

export const TICKET_STATUS_LABEL = {
  open: "Open",
  accepted: "Accepted",
  pending_user_resolution: "Waiting for user",
  pending_follow_up: "Pending follow-up",
  solved_closed: "Solved",
  not_solved_closed: "Not solved",
  closed_by_team: "Closed by team",
  expired: "Auto-closed"
};

export const state = {
  currentTab: "home",
  members: [],
  communitySummary: { date: "", data: null, loading: false },
  activity: {
    rows: [],
    sort: { key: "created_at", ascending: false },
    filters: { member_id: "", action: "", search: "" },
    expandedWeeks: new Set()
  },
  stats: {
    rows: [],
    groups: [],
    selectedGroupId: "",
    grouping: "date",
    expandedWeeks: new Set()
  },
  proof: {
    rows: [],
    expandedWeeks: new Set()
  },
  tickets: {
    rows: [],
    groups: [],
    issueStats: [],
    issueReport: null,
    filters: { assigned_member_id: "", scheduled_member_id: "", status: "", telegram_chat_id: "" },
    expandedIds: new Set()
  },
  ticketSearch: {
    rows: [],
    issueStats: [],
    issueReport: null,
    filters: { q: "", member_id: "", status: "" },
    expandedIds: new Set()
  },
  memberDetail: {
    open: false,
    memberId: null,
    memberName: null
  },
  memberProfile: {
    memberId: null,
    from: "",
    to: "",
    view: "",
    loading: false,
    profile: null,
    tickets: [],
    proof: [],
    activity: [],
    groupStats: []
  },
  issueReport: {
    category: "",
    from: "",
    to: "",
    data: null,
    loading: false
  }
};

// Focused per-member views. Each maps a ?view= value to the member-profile
// section it isolates. Used to build separate shareable links (e.g. for Discourse).
export const MEMBER_VIEWS = {
  tickets: { section: "tickets", label: "Support Tickets" },
  proof: { section: "proof", label: "Proof of Work" },
  activity: { section: "activity", label: "Activity History" },
  stats: { section: "stats", label: "Stats" }
};

export function normalizeMemberView(value) {
  const key = String(value || "").toLowerCase();
  return MEMBER_VIEWS[key] ? key : "";
}
