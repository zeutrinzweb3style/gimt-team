// Guards for the block editor's Enter behaviour.
//
// The "+ Add a block" button was removed: Enter is now the only way to add a
// block, so it has to work from every kind of block. A heading, an image
// caption, a table cell and a link-only subpage used to be dead ends — Enter
// did nothing there and the button was the only escape. These tests pin that
// Enter adds a paragraph from each of them, and that the button is gone.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

const pagesSource = readFileSync(new URL("../public/app/pages.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");

// ----------------------------------------------------------- the button --

test("the Add a block button is gone from the editor and the stylesheet", () => {
  assert.doesNotMatch(pagesSource, /pages-add-block/, "the editor must not render the button");
  assert.doesNotMatch(pagesSource, /pg-add-block/, "the button class must not remain in the source");
  assert.doesNotMatch(css, /\.pg-add-block/, "the button styles must be removed");
});

// ------------------------------------------------- a small DOM to type in --

class FakeElement {
  constructor(tag = "div") {
    this.tag = tag;
    this.dataset = {};
    this.listeners = {};
    this.closestMap = {};
    this.innerHTML = "";
    this.classList = { toggle() {}, add() {}, remove() {}, contains: () => false };
  }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  dispatch(type, event) { for (const fn of this.listeners[type] || []) fn(event); }
  closest(selector) { return this.closestMap[selector] ?? null; }
  focus() { this.focused = true; }
}

class FakeTextArea extends FakeElement {}
class FakeInput extends FakeElement {}
class FakeButton extends FakeElement {}

function pressEnter(target) {
  let prevented = false;
  target.editor.dispatch("keydown", {
    key: "Enter",
    shiftKey: false,
    target,
    preventDefault() { prevented = true; }
  });
  return prevented;
}

/** Install a stub document, import the module, and hand back its key handler. */
async function setupEditor(working, current = { id: "page-1", created_by_member_id: "m1" }) {
  const previous = {
    document: globalThis.document,
    window: globalThis.window,
    HTMLElement: globalThis.HTMLElement,
    HTMLTextAreaElement: globalThis.HTMLTextAreaElement,
    HTMLInputElement: globalThis.HTMLInputElement,
    HTMLButtonElement: globalThis.HTMLButtonElement
  };

  const editor = new FakeElement();
  const focused = [];
  const cellElements = new Map();
  const makeCell = (selector) => {
    if (!cellElements.has(selector)) {
      const cell = new FakeInput("input");
      cell.focus = () => focused.push(selector);
      cellElements.set(selector, cell);
    }
    return cellElements.get(selector);
  };

  globalThis.HTMLElement = FakeElement;
  globalThis.HTMLTextAreaElement = FakeTextArea;
  globalThis.HTMLInputElement = FakeInput;
  globalThis.HTMLButtonElement = FakeButton;
  globalThis.window = {
    addEventListener() {},
    clearTimeout() {},
    setTimeout: () => 0
  };
  globalThis.document = {
    body: new FakeElement(),
    querySelector: (selector) => {
      if (selector === "#pages-editor") return editor;
      if (selector.startsWith("[data-pg-cell=")) return makeCell(selector);
      return null;
    },
    querySelectorAll: () => [],
    addEventListener() {}
  };

  const { state } = await import("../public/app/state.js");
  const { initPages } = await import("../public/app/pages.js");
  state.pages.working = working;
  state.pages.current = current;
  state.pages.expanded = new Set();
  initPages();

  const restore = () => {
    globalThis.document = previous.document;
    globalThis.window = previous.window;
    globalThis.HTMLElement = previous.HTMLElement;
    globalThis.HTMLTextAreaElement = previous.HTMLTextAreaElement;
    globalThis.HTMLInputElement = previous.HTMLInputElement;
    globalThis.HTMLButtonElement = previous.HTMLButtonElement;
  };
  return { state, editor, focused, restore };
}

// ------------------------------------------------------------ Enter works --

test("Enter on a paragraph adds the next paragraph", async () => {
  const first = { id: "p1", type: "paragraph", text: "one" };
  const { state, editor, restore } = await setupEditor([first]);
  try {
    const target = new FakeTextArea("textarea");
    target.editor = editor;
    target.dataset.pgText = "p1";
    assert.equal(pressEnter(target), true, "Enter must be handled");
    assert.equal(state.pages.working.length, 2);
    assert.equal(state.pages.working[1].type, "paragraph");
  } finally {
    restore();
  }
});

test("Enter on a heading adds a paragraph after it", async () => {
  // A heading used to swallow Enter ("headings stay single-line") and the
  // removed button was the only way past it.
  const heading = { id: "h1", type: "heading", level: 1, text: "Title" };
  const { state, editor, restore } = await setupEditor([heading]);
  try {
    const target = new FakeTextArea("textarea");
    target.editor = editor;
    target.dataset.pgText = "h1";
    assert.equal(pressEnter(target), true);
    assert.equal(state.pages.working.length, 2);
    assert.equal(state.pages.working[1].type, "paragraph");
    assert.equal(state.pages.working[1].text, "");
  } finally {
    restore();
  }
});

test("Enter inside a toggle adds a paragraph inside the toggle", async () => {
  const toggle = { id: "t1", type: "toggle", level: 2, text: "Section", collapsed: false, children: [{ id: "c1", type: "paragraph", text: "body" }] };
  const { state, editor, restore } = await setupEditor([toggle]);
  try {
    const target = new FakeTextArea("textarea");
    target.editor = editor;
    target.dataset.pgText = "t1";
    assert.equal(pressEnter(target), true);
    assert.equal(state.pages.working.length, 1, "the toggle itself is unchanged");
    assert.equal(state.pages.working[0].children.length, 2);
    assert.equal(state.pages.working[0].children[1].type, "paragraph");
  } finally {
    restore();
  }
});

test("Enter on an image caption adds a paragraph after the image", async () => {
  const image = { id: "i1", type: "image", text: "A caption", image: { url: "/x.png" } };
  const { state, editor, restore } = await setupEditor([image]);
  try {
    const target = new FakeTextArea("textarea");
    target.editor = editor;
    target.dataset.pgCaption = "i1";
    assert.equal(pressEnter(target), true);
    assert.equal(state.pages.working.length, 2);
    assert.equal(state.pages.working[1].type, "paragraph");
  } finally {
    restore();
  }
});

test("Enter on a table cell walks the grid, then leaves the table", async () => {
  const table = { id: "tb1", type: "table", table: { header: true, rows: [["a", "b"], ["c", "d"]] } };
  const { state, editor, focused, restore } = await setupEditor([table]);
  try {
    const cell = (row, col) => {
      const input = new FakeInput("input");
      input.editor = editor;
      input.dataset.pgCell = `tb1:${row}:${col}`;
      return input;
    };

    // Mid-grid Enter moves the caret on instead of adding a block.
    assert.equal(pressEnter(cell(0, 0)), true);
    assert.deepEqual(focused, ['[data-pg-cell="tb1:0:1"]']);
    assert.equal(state.pages.working.length, 1);

    assert.equal(pressEnter(cell(1, 0)), true);
    assert.deepEqual(focused.at(-1), '[data-pg-cell="tb1:1:1"]');

    // The last cell has nowhere left to go, so Enter adds a paragraph after the
    // table — the escape that the removed button used to provide.
    assert.equal(pressEnter(cell(1, 1)), true);
    assert.equal(state.pages.working.length, 2);
    assert.equal(state.pages.working[1].type, "paragraph");
  } finally {
    restore();
  }
});

test("Enter on a subpage block adds a paragraph below it", async () => {
  // A subpage block is a link with no text field, so it had no Enter at all.
  const subpage = { id: "s1", type: "subpage", pageId: "child-1", text: "" };
  const { state, editor, restore } = await setupEditor([subpage]);
  try {
    const blockEl = new FakeElement();
    blockEl.dataset.pgBlock = "s1";
    blockEl.closestMap[".pg-block-subpage"] = blockEl;
    blockEl.editor = editor;
    assert.equal(pressEnter(blockEl), true);
    assert.equal(state.pages.working.length, 2);
    assert.equal(state.pages.working[1].type, "paragraph");
  } finally {
    restore();
  }
});

test("Enter on the subpage's own buttons is left to the button", async () => {
  // The link opens the page and ✕ removes it; Enter there must not also insert
  // a paragraph.
  const subpage = { id: "s1", type: "subpage", pageId: "child-1", text: "" };
  const { state, editor, restore } = await setupEditor([subpage]);
  try {
    const button = new FakeButton("button");
    button.dataset.pgBlock = "s1";
    button.closestMap[".pg-block-subpage"] = { dataset: { pgBlock: "s1" } };
    button.editor = editor;
    assert.equal(pressEnter(button), false, "a button keeps its own Enter");
    assert.equal(state.pages.working.length, 1);
  } finally {
    restore();
  }
});
