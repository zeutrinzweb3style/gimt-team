// Identity-only login for the dashboard: Telegram inside a Mini App, Google in
// an ordinary browser.
//
// The Telegram button appears only inside a Mini App (window.Telegram.WebApp
// with non-empty initData), and that initData is re-verified on the server with
// the bot token. The Google button is a plain link to the server-side OAuth
// start, so no Google SDK is loaded and no token ever reaches the page.

import { $ } from "./utils.js";

const AUTH_ENDPOINT = "/api/web/members?auth=";
const TELEGRAM_SDK_URL = "https://telegram.org/js/telegram-web-app.js";

const AUTH_ERROR_MESSAGES = {
  not_member: "That Google account is not linked to a registered team member.",
  expired: "That sign-in expired. Please try again.",
  failed: "Google sign-in failed. Please try again.",
  unconfigured: "Google sign-in is not configured on this deployment."
};

function tg() {
  return window.Telegram?.WebApp;
}

function hasInitData() {
  return Boolean(tg()?.initData);
}

let sdkPromise = null;

/**
 * Load the Telegram WebApp SDK on demand. It used to be a deferred script in the
 * document head, which placed it ahead of the module bundle in document order,
 * so a slow or unreachable telegram.org delayed the entire dashboard. Nothing on
 * the boot path needs it: only Mini App detection and login do.
 */
function loadTelegramSdk() {
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise((resolve) => {
    if (tg()) { resolve(tg()); return; }
    const script = document.createElement("script");
    script.src = TELEGRAM_SDK_URL;
    script.async = true;
    script.addEventListener("load", () => resolve(tg() ?? null));
    script.addEventListener("error", () => resolve(null));
    document.head.appendChild(script);
  });
  return sdkPromise;
}

/**
 * Telegram Web and Desktop hand init data to the iframe from the parent, so it
 * can arrive a moment after the SDK itself loads. Wait briefly for it instead of
 * concluding too early that this is an ordinary browser.
 */
async function waitForInitData(timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!hasInitData()) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return true;
}

async function postAuth(mode, body) {
  const response = await fetch(`${AUTH_ENDPOINT}${mode}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(body ?? {})
  });
  let payload = {};
  try {
    payload = await response.json();
  } catch (_error) {
    payload = {};
  }
  return { ok: response.ok, status: response.status, payload };
}

let miniApp = false;
let lastIdentity;

/**
 * Paints the header for either state. Telegram login only works inside the Mini
 * App and Google login only works in a real browser tab, so exactly one button
 * is offered.
 */
function render(state, name) {
  const container = $("#telegram-auth");
  const loginBtn = $("#telegram-login-btn");
  const googleBtn = $("#google-login-btn");
  const identity = $("#telegram-identity");
  const nameEl = $("#telegram-identity-name");
  if (!container || !identity || !nameEl) return;

  const connected = state === "connected";
  container.classList.remove("hidden");
  container.classList.add("flex");
  identity.classList.toggle("hidden", !connected);
  identity.classList.toggle("inline-flex", connected);
  loginBtn?.classList.toggle("hidden", connected || !miniApp);
  googleBtn?.classList.toggle("hidden", connected || miniApp);
  if (connected) nameEl.textContent = `✅ Connected as ${name}`;
  emitIdentity(connected ? name : null);
}

/** Subscribers hear about identity changes; `null` means signed out. */
const identityListeners = new Set();

export function onIdentityChange(listener) {
  identityListeners.add(listener);
}

function emitIdentity(name) {
  if (name === lastIdentity) return;
  lastIdentity = name;
  for (const listener of identityListeners) {
    try {
      listener(name);
    } catch (_error) {
      // A failing listener must not break the login flow.
    }
  }
}

/** The connected member's name, or null. */
async function loadSession() {
  try {
    const response = await fetch(`${AUTH_ENDPOINT}me`, { headers: { accept: "application/json" }, credentials: "same-origin" });
    const payload = await response.json();
    if (payload?.connected) return payload.connected.member_name;
  } catch (_error) {
    // Not connected or endpoint unavailable; fall through to the login button.
  }
  return null;
}

async function login() {
  const loginBtn = $("#telegram-login-btn");
  const original = loginBtn?.textContent;
  if (loginBtn) loginBtn.textContent = "Connecting…";

  await loadTelegramSdk();
  if (!(await waitForInitData())) {
    if (loginBtn) loginBtn.textContent = original;
    alert("Open this dashboard from the Telegram bot to sign in.");
    return;
  }

  const initData = tg()?.initData;
  if (!initData) {
    if (loginBtn) loginBtn.textContent = original;
    return;
  }

  const { ok, payload } = await postAuth("login", { initData });
  if (ok && payload?.connected) {
    render("connected", payload.connected.member_name);
    return;
  }

  if (loginBtn) loginBtn.textContent = original;
  alert(payload?.error || "Telegram login failed. Open the dashboard from the bot and try again.");
}

async function logout() {
  await postAuth("logout");
  render("signed-out");
}

/** A failed Google login comes back as ?auth_error=<code>; show it, then clean the URL. */
function reportAuthError() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("auth_error");
  if (!code) return;

  params.delete("auth_error");
  const query = params.toString();
  window.history.replaceState({}, "", `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`);
  alert(AUTH_ERROR_MESSAGES[code] || "Sign-in failed. Please try again.");
}

export async function initAuth() {
  const container = $("#telegram-auth");
  if (!container) return;

  reportAuthError();

  $("#telegram-login-btn")?.addEventListener("click", login);
  $("#telegram-logout-btn")?.addEventListener("click", logout);
  const googleBtn = $("#google-login-btn");
  if (googleBtn) googleBtn.href = `${AUTH_ENDPOINT}google&next=${encodeURIComponent(window.location.pathname)}`;

  const name = await loadSession();
  if (name) {
    render("connected", name);
    return;
  }

  // Offer Google right away: an ordinary browser is the common case, and it
  // should not wait on telegram.org. If init data shows up the page is a Mini
  // App after all, and the buttons swap.
  render("signed-out");

  await loadTelegramSdk();
  if (await waitForInitData()) {
    miniApp = true;
    render("signed-out");
  }
}
