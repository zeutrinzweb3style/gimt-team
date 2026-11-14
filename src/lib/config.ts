export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

export function optionalEnv(name: string): string | undefined {
  return process.env[name] || undefined;
}


export function isTeamInboxEnabled(): boolean {
  return (process.env.TEAM_INBOX_MODE || "").trim().toLowerCase() !== "off";
}

/** Spam reporting is on unless explicitly switched off with SPAM_REPORTS_ENABLED=off. */
export function isSpamReportingEnabled(): boolean {
  return (process.env.SPAM_REPORTS_ENABLED || "on").trim().toLowerCase() !== "off";
}

/** Time reserved for the scheduled responder before coverage may reply. */
export const TEAM_INBOX_PRIMARY_GRACE_MINUTES = 10;

export type SupportMode = "old" | "ai";

export function getSupportMode(): SupportMode {
  const rawValue = (process.env.SUPPORT_MODE || "old").trim().toLowerCase();
  if (rawValue === "ai" || rawValue === "old") return rawValue;

  console.warn(`Invalid SUPPORT_MODE=${process.env.SUPPORT_MODE}. Falling back to old support flow.`);
  return "old";
}
