import { renderIssueCategoryOptions } from "./issue-report.js";
import { fetchJson } from "./utils.js";

// Fallback only; the canonical list comes from the issue-report API so it cannot
// drift from the classifier in src/lib/ai-support.ts. "Swap Failed" is a
// reporting-only rollup that includes MiniPay GoodDapp Swap Failed, so both the
// umbrella total and the leaf count are shown.
export const ISSUE_CATEGORIES = [
  "How to Claim G$",
  "GoodWallet Claiming Failed",
  "Cannot Claim G$",
  "Face Verification Failed",
  "Wallet Connection Issue",
  "Swap Failed",
  "MiniPay GoodDapp Swap Failed",
  "Gas Fee Issue",
  "Importing Wallet / Importing G$ Token",
  "Reward Not Received",
  "Transaction Failed",
  "General Failure / Error",
  "Pending Case Follow-Up",
  "User Provided Evidence",
  "Unknown Issue"
];

export let issueCategories = ISSUE_CATEGORIES.slice();

export async function loadIssueCategories() {
  try {
    const body = await fetchJson("/api/web/issue-report");
    if (Array.isArray(body?.categories) && body.categories.length > 0) {
      issueCategories = body.categories.filter((value) => typeof value === "string");
    }
  } catch (error) {
    console.warn(`Falling back to the bundled issue category list: ${error instanceof Error ? error.message : String(error)}`);
  }
  renderIssueCategoryOptions();
}

export function normalizeIssueCategory(value) {
  const raw = String(value || "").trim();
  return issueCategories.includes(raw) ? raw : "";
}
