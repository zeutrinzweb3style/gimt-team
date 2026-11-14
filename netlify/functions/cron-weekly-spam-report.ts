import vercelHandler from "../../api/cron/weekly-spam-report.js";
import { createNetlifyHandler } from "./_adapter.js";

export const handler = createNetlifyHandler(vercelHandler);
