import vercelHandler from "../../api/cron/daily-report.js";
import { createNetlifyHandler } from "./_adapter.js";

const baseHandler = createNetlifyHandler(vercelHandler);

/**
 * Scheduled Netlify invocation of the monthly spam summary. The work lives in
 * the shared daily-report handler (keeping Vercel within its 12-function limit),
 * so this wrapper only injects the ?spam=monthly query that selects that branch.
 */
export const handler = async (event: any) => {
  const rawQuery = event.rawQuery ? `${event.rawQuery}&spam=monthly` : "spam=monthly";
  const path = event.path ?? "/.netlify/functions/cron-monthly-spam-report";
  return baseHandler({
    ...event,
    path,
    rawQuery,
    rawUrl: `${path}?${rawQuery}`
  });
};
