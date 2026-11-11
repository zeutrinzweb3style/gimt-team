import { TEAM_SCHEDULE } from "../../src/lib/team-schedule.js";
import { listMemberProfiles, listRegistrations } from "../../src/lib/repository.js";
import { getSupabase } from "../../src/lib/supabase.js";

function sendJson(response: any, statusCode: number, payload: unknown) {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(payload));
}

export default async function handler(_request: any, response: any) {
  try {
    const db = getSupabase();
    const [registrations, profiles] = await Promise.all([
      listRegistrations(db),
      listMemberProfiles(db).catch(() => [])
    ]);
    const registrationByMember = new Map(registrations.map((r) => [r.member_id, r]));
    const profileByMember = new Map(profiles.map((p) => [p.member_id, p]));

    const members = TEAM_SCHEDULE.map((member) => {
      const registration = registrationByMember.get(member.id);
      const profile = profileByMember.get(member.id);
      return {
        id: member.id,
        name: member.name,
        timezone: member.timezone,
        shift_start_utc: member.shiftStartUtc,
        shift_end_utc: member.shiftEndUtc,
        registered: Boolean(registration),
        telegram_username: registration?.telegram_username ?? null,
        telegram_user_id: registration?.telegram_user_id ?? null,
        headline: profile?.headline ?? null,
        avatar_url: profile?.avatar?.url ?? null,
        link_count: Array.isArray(profile?.links) ? profile.links.length : 0,
        has_profile: Boolean(profile)
      };
    });

    sendJson(response, 200, { ok: true, members });
  } catch (error) {
    sendJson(response, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}
