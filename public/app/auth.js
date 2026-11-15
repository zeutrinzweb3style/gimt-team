// Identity-only Telegram login for the dashboard.
//
// The button only appears inside a Telegram Mini App (window.Telegram.WebApp
// with non-empty initData). Opening the site in a normal browser shows nothing,
// and any initData is re-verified on the server with the bot token, so the
// identity cannot be forged.

import { $ } from "./utils.js";

const AUTH_ENDPOINT = "/api/web/members?auth=";
const TELEGRAM_SDK_URL = "https://telegram.org/js/telegram-web-app.js";

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

function showIdentity(name) {
  const loginBtn = $("#telegram-login-btn");
  const identity = $("#telegram-identity");
  const nameEl = $("#telegram-identity-name");
  if (!loginBtn || !identity || !nameEl) return;
  loginBtn.classList.add("hidden");
  identity.classList.remove("hidden");
  identity.classList.add("inline-flex");
  nameEl.textContent = `✅ Connected as ${name}`;
  emitIdentity(name);
}

function showLogin() {
  const loginBtn = $("#telegram-login-btn");
  const identity = $("#telegram-identity");
  if (!loginBtn || !identity) return;
  identity.classList.add("hidden");
  identity.classList.remove("inline-flex");
  loginBtn.classList.remove("hidden");
  emitIdentity(null);
}

/** Subscribers hear about identity changes; `null` means signed out. */
const identityListeners = new Set();

export function onIdentityChange(listener) {
  identityListeners.add(listener);
}

function emitIdentity(name) {
  for (const listener of identityListeners) {
    try {
      listener(name);
    } catch (_error) {
      // A failing listener must not break the login flow.
    }
  }
}

async function loadSession() {
  try {
    const response = await fetch(`${AUTH_ENDPOINT}me`, { headers: { accept: "application/json" }, credentials: "same-origin" });
    const payload = await response.json();
    if (payload?.connected) {
      showIdentity(payload.connected.member_name);
      return true;
    }
  } catch (_error) {
    // Not connected or endpoint unavailable; fall through to the login button.
  }
  return false;
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
    showIdentity(payload.connected.member_name);
    return;
  }

  if (loginBtn) loginBtn.textContent = original;
  alert(payload?.error || "Telegram login failed. Open the dashboard from the bot and try again.");
}

async function logout() {
  await postAuth("logout");
  showLogin();
}

export async function initTelegramAuth() {
  const container = $("#telegram-auth");
  if (!container) return;

  const connected = await loadSession();
  if (connected) {
    container.classList.remove("hidden");
    container.classList.add("flex");
    $("#telegram-login-btn")?.addEventListener("click", login);
    $("#telegram-logout-btn")?.addEventListener("click", logout);
    return;
  }

  // No session yet. Only offer login inside the Mini App, but the SDK is loaded
  // on demand now, so wait for it and for the init data the Telegram client
  // hands the iframe before deciding this is an ordinary browser.
  await loadTelegramSdk();
  if (!(await waitForInitData())) return;

  container.classList.remove("hidden");
  container.classList.add("flex");
  $("#telegram-login-btn")?.addEventListener("click", login);
  $("#telegram-logout-btn")?.addEventListener("click", logout);
}
