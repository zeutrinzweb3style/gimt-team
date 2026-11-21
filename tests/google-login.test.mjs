// Integration tests for Google sign-in.
//
// The real handler runs against a stub of global fetch that emulates Supabase
// Auth's PKCE token endpoint and the PostgREST team_registrations read. The PKCE
// cookie signing, the code exchange, the email whitelist and the session cookie
// all execute as they do in production; only the network boundary is stubbed.

import assert from "node:assert/strict";
import { test } from "node:test";

process.env.TELEGRAM_BOT_TOKEN = "123456:test-token-for-sessions";
process.env.SESSION_SECRET = "test-session-secret";
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
process.env.SUPABASE_ANON_KEY = "anon-key";

const { OAUTH_COOKIE } = await import("../.test-build/src/lib/google-auth.js");
const handler = (await import("../.test-build/api/web/members.js")).default;

// ------------------------------------------------------- Supabase emulation --

let registrations = [];
let tokenCalls = [];

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return data; },
    async text() { return JSON.stringify(data); }
  };
}

/** PostgREST `ilike.` with backslash-escaped metacharacters, as the app sends it. */
function likeMatches(value, pattern) {
  const literal = pattern.replace(/\\([\\%_])/g, "$1");
  if (literal === value) return true;
  return String(value ?? "").toLowerCase() === literal.toLowerCase();
}

function matchesRegistration(row, searchParams) {
  for (const [key, value] of searchParams.entries()) {
    if (["select", "order", "limit", "on_conflict"].includes(key)) continue;
    if (value.startsWith("eq.")) {
      if (String(row[key]) !== value.slice(3)) return false;
    } else if (value.startsWith("ilike.")) {
      if (!likeMatches(row[key], value.slice(6))) return false;
    } else if (value.startsWith("is.null")) {
      if (row[key] !== null && row[key] !== undefined) return false;
    }
  }
  return true;
}

global.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === "string" ? input : input.url);

  if (url.pathname === "/auth/v1/token") {
    assert.equal(url.searchParams.get("grant_type"), "pkce");
    const body = JSON.parse(init.body);
    tokenCalls.push({ body, headers: init.headers });
    const user = tokenUser(body.auth_code);
    if (!user) return jsonResponse({ error: "invalid_grant" }, 400);
    return jsonResponse({ access_token: "token", token_type: "bearer", user });
  }

  if (url.pathname === "/rest/v1/team_registrations") {
    const rows = registrations.filter((row) => matchesRegistration(row, url.searchParams));
    return jsonResponse(rows.slice(0, Number(url.searchParams.get("limit") || rows.length)));
  }

  throw new Error(`unexpected fetch ${url.href}`);
};

/** The Supabase user each auth code resolves to. */
function tokenUser(code) {
  if (code === "unconfirmed-code") {
    return { id: "u-3", email: "betz@gmail.com", app_metadata: { provider: "google" } };
  }
  if (code === "wrong-provider") {
    return {
      id: "u-4",
      email: "betz@gmail.com",
      email_confirmed_at: "2026-01-01T00:00:00Z",
      app_metadata: { provider: "github" }
    };
  }
  if (code !== "good-code") return null;
  return {
    id: "u-1",
    email: "Betz@Gmail.com",
    email_confirmed_at: "2026-01-01T00:00:00Z",
    app_metadata: { provider: "google" },
    user_metadata: { email_verified: true }
  };
}

// ----------------------------------------------------------------- helpers --

function makeResponse() {
  const headers = {};
  return {
    statusCode: 200,
    body: "",
    setHeader(name, value) { headers[name.toLowerCase()] = value; },
    getHeader(name) { return headers[name.toLowerCase()]; },
    end(payload) { this.body = payload === undefined ? "" : String(payload); },
    json() { return JSON.parse(this.body); }
  };
}

function makeRequest(url, { method = "GET", body, cookie, headers = {} } = {}) {
  return {
    method,
    url,
    headers: cookie ? { cookie, ...headers } : { ...headers },
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body));
    }
  };
}

async function call(url, options) {
  const response = makeResponse();
  await handler(makeRequest(url, options), response);
  return response;
}

const HOST_HEADERS = { host: "gimt.example", "x-forwarded-proto": "https" };
const START = "/api/web/members?auth=google";

/** The cookie header for the pending-login cookie a start request sets. */
function pendingCookie(response) {
  const header = response.getHeader("set-cookie");
  assert.ok(header, "start must set a pending-login cookie");
  const cookie = Array.isArray(header) ? header[0] : header;
  return cookie.split(";")[0];
}

function sessionCookie(response) {
  const header = response.getHeader("set-cookie");
  if (!header) return null;
  const cookies = Array.isArray(header) ? header : [header];
  const found = cookies.find((cookie) => cookie.startsWith("gimt_session="));
  return found ? found.split(";")[0] : null;
}

const resetStore = () => {
  registrations = [
    { member_id: "betz", member_name: "Betz", email: "Betz@Gmail.com", telegram_user_id: 111 },
    { member_id: "omar", member_name: "Omar", email: null, telegram_user_id: 222 }
  ];
  tokenCalls = [];
};

// -------------------------------------------------------------------- tests --

test("the start redirects to Supabase with a PKCE challenge and a pending cookie", async () => {
  resetStore();
  const response = await call(`${START}&next=/stats`, { headers: HOST_HEADERS });

  assert.equal(response.statusCode, 302);
  const location = new URL(response.getHeader("location"));
  assert.equal(location.origin, "https://example.supabase.co");
  assert.equal(location.pathname, "/auth/v1/authorize");
  assert.equal(location.searchParams.get("provider"), "google");
  assert.equal(
    location.searchParams.get("redirect_to"),
    "https://gimt.example/api/web/members?auth=google-callback"
  );
  assert.equal(location.searchParams.get("code_challenge_method"), "s256");
  assert.match(location.searchParams.get("code_challenge"), /^[A-Za-z0-9_-]{43}$/);

  const cookie = pendingCookie(response);
  assert.ok(cookie.startsWith(`${OAUTH_COOKIE}=`));
  const raw = Array.isArray(response.getHeader("set-cookie")) ? response.getHeader("set-cookie")[0] : response.getHeader("set-cookie");
  assert.match(raw, /Path=\/api\/web\/members/);
  assert.match(raw, /HttpOnly/);
  assert.match(raw, /SameSite=Lax/);
  assert.match(raw, /Max-Age=600/);
});

test("a fresh challenge is minted for every start", async () => {
  resetStore();
  const first = new URL((await call(START, { headers: HOST_HEADERS })).getHeader("location"));
  const second = new URL((await call(START, { headers: HOST_HEADERS })).getHeader("location"));
  assert.notEqual(first.searchParams.get("code_challenge"), second.searchParams.get("code_challenge"));
});

test("a verified Google email signs in and issues the session cookie", async () => {
  resetStore();
  const start = await call(`${START}&next=/stats`, { headers: HOST_HEADERS });
  const cookie = pendingCookie(start);

  const callback = await call("/api/web/members?auth=google-callback&code=good-code", { cookie, headers: HOST_HEADERS });
  assert.equal(callback.statusCode, 302);
  assert.equal(callback.getHeader("location"), "/stats");

  assert.equal(tokenCalls.length, 1);
  assert.equal(tokenCalls[0].body.auth_code, "good-code");
  assert.match(tokenCalls[0].body.code_verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(tokenCalls[0].headers.apikey, "anon-key");

  const session = sessionCookie(callback);
  assert.ok(session, "callback must set gimt_session");

  const me = await call("/api/web/members?auth=me", { cookie: session });
  assert.deepEqual(me.json().connected, { member_id: "betz", member_name: "Betz", provider: "google" });
});

test("the email match is case-insensitive", async () => {
  resetStore();
  const start = await call(START, { headers: HOST_HEADERS });
  const callback = await call("/api/web/members?auth=google-callback&code=good-code", {
    cookie: pendingCookie(start),
    headers: HOST_HEADERS
  });
  assert.equal(callback.getHeader("location"), "/");
  assert.ok(sessionCookie(callback));
});

test("an unlinked Google account gets no session", async () => {
  resetStore();
  registrations = registrations.map((row) => ({ ...row, email: "someone.else@gmail.com" }));
  const start = await call(START, { headers: HOST_HEADERS });

  const callback = await call("/api/web/members?auth=google-callback&code=good-code", {
    cookie: pendingCookie(start),
    headers: HOST_HEADERS
  });
  assert.equal(callback.getHeader("location"), "/?auth_error=not_member");
  assert.equal(sessionCookie(callback), null);
});

test("a callback without the pending cookie is refused", async () => {
  resetStore();
  const callback = await call("/api/web/members?auth=google-callback&code=good-code", { headers: HOST_HEADERS });
  assert.equal(callback.getHeader("location"), "/?auth_error=expired");
  assert.equal(sessionCookie(callback), null);
  assert.equal(tokenCalls.length, 0);
});

test("a tampered pending cookie is refused", async () => {
  resetStore();
  const start = await call(START, { headers: HOST_HEADERS });
  const cookie = `${pendingCookie(start)}tampered`;

  const callback = await call("/api/web/members?auth=google-callback&code=good-code", { cookie, headers: HOST_HEADERS });
  assert.equal(callback.getHeader("location"), "/?auth_error=expired");
  assert.equal(sessionCookie(callback), null);
});

test("an unconfirmed email and a non-Google provider are rejected", async () => {
  resetStore();
  for (const code of ["unconfirmed-code", "wrong-provider"]) {
    const start = await call(START, { headers: HOST_HEADERS });
    const callback = await call(`/api/web/members?auth=google-callback&code=${code}`, {
      cookie: pendingCookie(start),
      headers: HOST_HEADERS
    });
    assert.equal(callback.getHeader("location"), "/?auth_error=failed", code);
    assert.equal(sessionCookie(callback), null, code);
  }
});

test("a rejected code from Supabase fails closed", async () => {
  resetStore();
  const start = await call(START, { headers: HOST_HEADERS });
  const callback = await call("/api/web/members?auth=google-callback&code=stale-code", {
    cookie: pendingCookie(start),
    headers: HOST_HEADERS
  });
  assert.equal(callback.getHeader("location"), "/?auth_error=failed");
  assert.equal(sessionCookie(callback), null);
});

test("next cannot be turned into an open redirect", async () => {
  resetStore();
  for (const next of ["//evil.example", "https://evil.example", "/\\evil.example"]) {
    const start = await call(`${START}&next=${encodeURIComponent(next)}`, { headers: HOST_HEADERS });
    const callback = await call("/api/web/members?auth=google-callback&code=good-code", {
      cookie: pendingCookie(start),
      headers: HOST_HEADERS
    });
    assert.equal(callback.getHeader("location"), "/", next);
  }
});

test("an unconfigured deployment sends the user back with a reason", async () => {
  resetStore();
  const key = process.env.SUPABASE_ANON_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_ANON_KEY;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    const response = await call(START, { headers: HOST_HEADERS });
    assert.equal(response.getHeader("location"), "/?auth_error=unconfigured");
    assert.equal(response.getHeader("set-cookie"), undefined);
  } finally {
    process.env.SUPABASE_ANON_KEY = key;
    process.env.SUPABASE_SERVICE_ROLE_KEY = serviceKey;
  }
});

test("the session cookie rejects a bad provider claim", async () => {
  resetStore();
  const { createSessionCookie } = await import("../.test-build/src/lib/telegram-auth.js");
  const forged = await createSessionCookie(
    { memberId: "betz", memberName: "Betz", provider: "github", exp: Math.floor(Date.now() / 1000) + 60 },
    process.env.SESSION_SECRET
  );
  const me = await call("/api/web/members?auth=me", { cookie: `gimt_session=${encodeURIComponent(forged)}` });
  assert.equal(me.json().connected, null);
});
