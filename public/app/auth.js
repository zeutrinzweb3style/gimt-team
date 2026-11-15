// Identity-only Telegram login for the dashboard.
//
// The button only appears inside a Telegram Mini App (window.Telegram.WebApp
// with non-empty initData). Opening the site in a normal browser shows nothing,
// and any initData is re-verified on the server with the bot token, so the
// identity cannot be forged.

import { $ } from "./utils.js";

const AUTH_ENDPOINT = "/api/web/members?auth=";

function tg() {
  return window.Telegram?.WebApp;
}

function hasInitData() {
  return Boolean(tg()?.initData);
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
}

function showLogin() {
  const loginBtn = $("#telegram-login-btn");
  const identity = $("#telegram-identity");
  if (!loginBtn || !identity) return;
  identity.classList.add("hidden");
  identity.classList.remove("inline-flex");
  loginBtn.classList.remove("hidden");
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
  const initData = tg()?.initData;
  if (!initData) return;

  const original = loginBtn?.textContent;
  if (loginBtn) loginBtn.textContent = "Connecting…";

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
  if (!connected) {
    // No valid session yet: only offer login inside the Mini App.
    if (!hasInitData()) return;
    container.classList.remove("hidden");
    container.classList.add("flex");
    $("#telegram-login-btn")?.addEventListener("click", login);
    $("#telegram-logout-btn")?.addEventListener("click", logout);
    return;
  }

  container.classList.remove("hidden");
  container.classList.add("flex");
  $("#telegram-login-btn")?.addEventListener("click", login);
  $("#telegram-logout-btn")?.addEventListener("click", logout);
}
