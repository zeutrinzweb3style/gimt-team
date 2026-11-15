// Guards for the standalone shared-page view.
//
// A share link (`/?page=<token>`) is opened by a visitor who holds only the
// link, and it must read as that one page — not as the dashboard. The shell
// used to stay on screen behind it: a sticky brand bar carrying the Telegram
// login button and Refresh, the nav tab row, and the footer. The fix hides that
// chrome through a body class the tab router toggles, so these tests pin the
// contract in three places: the router selects the panel and sets the class, the
// stylesheet hides exactly the shell chrome, and a visitor never sees an empty
// dashboard while the page is still loading.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
const main = readFileSync(new URL("../public/app/main.js", import.meta.url), "utf8");

// ------------------------------------------------------- the tab router --

test("the tab router marks the shared page as a standalone view", async () => {
  const classes = new Set();
  const body = {
    dataset: {},
    classList: {
      toggle: (name, on) => { if (on) classes.add(name); else classes.delete(name); },
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name)
    }
  };
  const panel = (tab) => ({ dataset: { tabPanel: tab }, classList: { toggle() {} } });
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  globalThis.document = {
    body,
    querySelector: (selector) => (selector === "#last-updated" ? { textContent: "" } : null),
    querySelectorAll: (selector) => (selector === "[data-tab-panel]" ? [panel("pages-shared"), panel("home")] : []),
    addEventListener() {}
  };
  globalThis.window = { addEventListener() {}, location: { href: "https://example.test/?page=abc" } };
  globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });

  try {
    const { state } = await import("../public/app/state.js");
    const { switchTab } = await import("../public/app/tabs.js");

    switchTab("pages-shared");
    assert.ok(classes.has("shared-page-mode"), "opening a shared page must add shared-page-mode");
    assert.equal(state.currentTab, "pages-shared");

    switchTab("home");
    assert.ok(!classes.has("shared-page-mode"), "leaving the shared page must drop shared-page-mode");
  } finally {
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
  }
});

// --------------------------------------------------------- the stylesheet --

test("only the active tab panel is displayed", () => {
  // A bare `.pages-page { display: block }` has the same specificity as
  // `[data-tab-panel] { display: none }` but is declared later, so it kept the
  // sidebar and editor on screen in every view — on a shared page it read as a
  // blank panel with buttons sitting above the page content.
  assert.doesNotMatch(
    css,
    /^\.pages-page\s*\{[^}]*display:\s*block/m,
    "the pages panel must not override the global panel rule for every view"
  );
  assert.match(css, /\.pages-page\.active\s*\{[^}]*display:\s*block/);
  assert.match(css, /\[data-tab-panel\]\s*\{\s*display:\s*none/);
  assert.match(css, /\[data-tab-panel\]\.active\s*\{\s*display:\s*block/);
});

test("shared-page-mode hides the shell chrome and keeps the page content", () => {
  assert.match(
    css,
    /body\.shared-page-mode\s*>\s*header\s*,\s*body\.shared-page-mode\s+footer\s*\{[^}]*display:\s*none/,
    "the brand bar and the footer must be hidden on a shared page"
  );
  assert.match(
    css,
    /body\.shared-page-mode\s+main\s*\{[^}]*max-width:\s*900px/,
    "the shared page content must be centred in a single column"
  );
  // The shared panel itself is a normal tab panel, so it must never be hidden
  // by the standalone mode.
  assert.doesNotMatch(css, /shared-page-mode[^{]*\[data-tab-panel/);
});

test("the shell header is scoped to a direct child, so the member modal is untouched", () => {
  // `header` alone also matches the member modal's inner <header>; the rule must
  // use the child combinator so only the dashboard shell is hidden.
  assert.doesNotMatch(css, /body\.shared-page-mode\s+header\s*,/);
  assert.match(css, /body\.shared-page-mode\s*>\s*header/);
});

// -------------------------------------------------------- the boot route --

test("a share link selects the page panel before the page request resolves", () => {
  // The visitor must not stare at an empty dashboard while the page loads: the
  // panel is selected (and the loading state shown) first, then the page lands.
  const branch = main.slice(main.indexOf("if (initialShareToken)"));
  const switchAt = branch.indexOf('switchTab("pages-shared")');
  const fetchAt = branch.indexOf("openPageByToken(initialShareToken)");
  assert.notEqual(switchAt, -1, "the share branch must select the shared panel");
  assert.notEqual(fetchAt, -1, "the share branch must still load the page by token");
  assert.ok(
    switchAt < fetchAt,
    "the panel must be selected before the page request, so the shell is replaced immediately"
  );
});
