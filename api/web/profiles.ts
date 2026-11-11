import { getMemberProfile, listMemberProfiles } from "../../src/lib/repository.js";
import { getSupabase } from "../../src/lib/supabase.js";

function sendJson(response: any, statusCode: number, payload: unknown) {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(payload));
}

export default async function handler(request: any, response: any) {
  try {
    const url = new URL(request.url ?? "/", "https://example.com");
    const memberId = url.searchParams.get("member_id");
    const db = getSupabase();

    if (memberId) {
      const profile = await getMemberProfile(db, memberId);
      sendJson(response, 200, { ok: true, profile });
      return;
    }

    const profiles = await listMemberProfiles(db);
    sendJson(response, 200, { ok: true, count: profiles.length, profiles });
  } catch (error) {
    sendJson(response, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}
