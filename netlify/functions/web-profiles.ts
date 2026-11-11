import vercelHandler from "../../api/web/profiles.js";
import { createNetlifyHandler } from "./_adapter.js";

export const handler = createNetlifyHandler(vercelHandler);
