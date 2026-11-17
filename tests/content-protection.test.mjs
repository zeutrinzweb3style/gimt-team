// Guards for the globally enforced content protection on published pages.
//
// A published page is the standalone shared view (`/?page=<token>`). Its body is
// locked by default — no selection, copy, cut, right-click or drag — while the
// editor and the rest of the dashboard are untouched. These tests exercise the
// real module against a fake document, and pin the markup contract in
// `pages.js` and the visual half in `styles.css`.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

import {
  BLOCKED_COPY_NOTICE,
  PROTECTED_ATTR,
  initContentProtection,
  isProtectedNode
} from "../public/app/content-protection.js";

const pages = readFileSync(new URL("../public/app/pages.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");

// ------------------------------------------------------------ fake DOM --

/**
 * A minimal element: `closest` walks the real parent chain and answers the two
 * selectors the module uses — the protected-region marker and the interactive
 * control list — from flags set on the node.
 */
function node({ tag = "div", protected: isProtected = false, interactive = false, parent = null } = {}) {
  const self = {
    tagName: tag.toUpperCase(),
    nodeType: 1,
    parentElement: parent,
    protectedFlag: isProtected,
    interactiveFlag: interactive,
    closest(selector) {
      for (let cur = self; cur; cur = cur.parentElement) {
        if (selector.startsWith("[data-content-protected]") && cur.protectedFlag) return cur;
        if (selector.includes("button") && cur.interactiveFlag) return cur;
      }
      return null;
    }
  };
  return self;
}

/** A published region with one block inside it, plus a free-standing editor node. */
function makeDocument() {
  const handlers = new Map();
  const protectedRoot = node({ protected: true });
  const insideBlock = node({ parent: protectedRoot });
  return {
    dataset: {},
    protectedRoot,
    insideBlock,
    editorNode: node(),
    addEventListener(type, fn) {
      if (!handlers.has(type)) handlers.set(type, []);
      handlers.get(type).push(fn);
    },
    fire(type, event) {
      for (const fn of handlers.get(type) || []) fn(event);
    }
  };
}

function eventFor(target, extra = {}) {
  const calls = { preventDefault: 0, clipboard: null };
  const event = {
    target,
    preventDefault() { calls.preventDefault += 1; },
    ...extra
  };
  Object.defineProperty(event, "clipboardData", {
    get() {
      calls.clipboard = calls.clipboard || { writes: {}, setData(k, v) { this.writes[k] = v; } };
      return calls.clipboard;
    }
  });
  event.calls = calls;
  return event;
}

function withSelection(rangeContainer, run) {
  const previous = globalThis.getSelection;
  globalThis.getSelection = () => ({
    rangeCount: 1,
    getRangeAt: () => ({ commonAncestorContainer: rangeContainer })
  });
  try {
    return run();
  } finally {
    if (previous === undefined) delete globalThis.getSelection;
    else globalThis.getSelection = previous;
  }
}

// --------------------------------------------------------- the module --

test("copy, cut, right-click, drag and selection are cancelled in published content", () => {
  const doc = makeDocument();
  initContentProtection(doc);
  const inside = node({ protected: true });

  for (const type of ["copy", "cut", "contextmenu", "dragstart", "selectstart"]) {
    const event = eventFor(inside);
    doc.fire(type, event);
    assert.equal(event.calls.preventDefault, 1, `${type} must be cancelled inside a published page`);
  }
});

test("a copy inside a published page leaves a notice instead of the content", () => {
  const doc = makeDocument();
  initContentProtection(doc);
  const event = eventFor(node({ protected: true }));
  doc.fire("copy", event);
  assert.equal(event.calls.clipboard.writes["text/plain"], BLOCKED_COPY_NOTICE);
});

test("the editor and the rest of the dashboard are never blocked", () => {
  const doc = makeDocument();
  initContentProtection(doc);
  const editor = node(); // no protected ancestor

  for (const type of ["copy", "cut", "contextmenu", "dragstart", "selectstart"]) {
    const event = eventFor(editor);
    doc.fire(type, event);
    assert.equal(event.calls.preventDefault, 0, `${type} must pass through outside published content`);
  }
});

test("a selection that reaches into published content is blocked even from outside", () => {
  // A reader can start the drag in the dashboard margin and end it over the
  // page: the event target is outside, but the selection is not.
  const doc = makeDocument();
  initContentProtection(doc);
  const outside = node();
  const insideText = node({ protected: true });

  withSelection(insideText, () => {
    const event = eventFor(outside);
    doc.fire("copy", event);
    assert.equal(event.calls.preventDefault, 1, "a selection over protected text must not be copied");
  });

  withSelection(outside, () => {
    const event = eventFor(outside);
    doc.fire("copy", event);
    assert.equal(event.calls.preventDefault, 0, "a selection outside the page copies normally");
  });
});

test("links and controls inside a published page keep their behaviour", () => {
  const doc = makeDocument();
  initContentProtection(doc);
  const link = node({ protected: true, interactive: true, tag: "a" });

  const event = eventFor(link);
  doc.fire("contextmenu", event);
  assert.equal(event.calls.preventDefault, 0, "a link keeps its right-click menu");

  // A copy over protected text is still cancelled even when a control was the
  // target, so a link is not a way around the lock.
  const copy = eventFor(link);
  doc.fire("copy", copy);
  assert.equal(copy.calls.preventDefault, 1);
});

test("protection binds once, however often init runs", () => {
  const doc = makeDocument();
  initContentProtection(doc);
  initContentProtection(doc);
  const event = eventFor(node({ protected: true }));
  doc.fire("contextmenu", event);
  assert.equal(event.calls.preventDefault, 1, "a second init must not double-bind the handlers");
});

test("isProtectedNode reports the region of a node", () => {
  assert.equal(isProtectedNode(node({ protected: true })), true);
  assert.equal(isProtectedNode(node()), false);
  assert.equal(isProtectedNode(null), false);
});

// ------------------------------------------------ the published surface --

test("the shared page card is marked as published content", () => {
  // The mark sits on the whole card, so every block — paragraphs, headings,
  // tables, lists, images, captions — is covered without marking each one.
  assert.match(pages, /<article class="pg-shared-card" \$\{PROTECTED_ATTR\}="true">/);
  assert.match(pages, /import \{ PROTECTED_ATTR, initContentProtection \} from "\.\/content-protection\.js"/);
});

test("the editor is never marked as published content", () => {
  // The editor template builds its own blocks container with no protected
  // attribute; only the shared view carries it.
  const editorTemplate = pages.slice(pages.indexOf("function renderEditor"), pages.indexOf("function renderBlocks"));
  assert.doesNotMatch(editorTemplate, /PROTECTED_ATTR/);
  assert.doesNotMatch(editorTemplate, /data-content-protected/);
});

test("protection is installed once, at pages init", () => {
  assert.match(pages, /initContentProtection\(\);/);
});

// ------------------------------------------------------ the visual half --

test("the stylesheet disables selection and drag on protected content only", () => {
  assert.match(css, /\[data-content-protected\]\s*\{[^}]*user-select:\s*none/);
  assert.match(css, /\[data-content-protected\]\s*img\s*\{[^}]*user-drag:\s*none/);
  // Links and controls keep selection, so navigation is unaffected.
  assert.match(css, /\[data-content-protected\]\s*a,\s*\[data-content-protected\]\s*button[^{]*\{[^}]*user-select:\s*auto/);
});

test("no editor selector is caught by the protection rules", () => {
  for (const selector of [".pg-editor", ".pg-text-input", "textarea.pg-text-input", ".pg-table-input"]) {
    assert.doesNotMatch(
      css,
      new RegExp(`\\[data-content-protected\\][^{]*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
      `${selector} must not be inside a protection rule`
    );
  }
});
