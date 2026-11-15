// Hierarchical pages: a Notion-style tree of pages and nested subpages.
//
// Editing needs a Telegram login and is limited to the member who created the
// page. A single page can also be opened by anyone holding its share link
// (?page=<token>), which the server resolves without a session.

import { state } from "./state.js";
import { $, $all, copyTextToButton, debounce, escapeHtml, fetchJson, postJson } from "./utils.js";

const PAGES_API = "/api/web/members?resource=pages";

const SLASH_COMMANDS = [
  { command: "page", label: "Subpage", hint: "Create a nested subpage", icon: "📄" },
  { command: "heading", label: "Toggle heading", hint: "Collapsible section", icon: "▸" },
  { command: "h1", label: "Heading 1", hint: "Large heading", icon: "H1" },
  { command: "h2", label: "Heading 2", hint: "Medium heading", icon: "H2" },
  { command: "h3", label: "Heading 3", hint: "Small heading", icon: "H3" }
];

function pagesState() {
  return state.pages;
}

function newBlock(type, extra = {}) {
  return { id: crypto.randomUUID(), type, text: "", ...extra };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/** Depth-first lookup returning the block and the array that holds it. */
function findBlock(blocks, id) {
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (block.id === id) return { block, list: blocks, index };
    if (block.children?.length) {
      const found = findBlock(block.children, id);
      if (found) return found;
    }
  }
  return null;
}

function findPage(id) {
  const local = pagesState().pages.find((page) => page.id === id);
  if (local) return local;
  // A shared page is viewed without the page list, so subpage titles come from
  // the linkedPages the shared endpoint returns.
  const linked = pagesState().shared?.linkedPages;
  return (linked && linked.find((page) => page.id === id)) || null;
}

function canEdit(page) {
  return Boolean(page) && page.created_by_member_id === pagesState().memberId;
}

/** Ancestor links (root first) so a subpage can navigate back to its parent. */
function parentTrail(page) {
  const byId = new Map(pagesState().pages.map((entry) => [entry.id, entry]));
  const chain = [];
  let cursor = page.parent_id ? byId.get(page.parent_id) : null;
  const seen = new Set([page.id]);
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    chain.unshift(cursor);
    cursor = cursor.parent_id ? byId.get(cursor.parent_id) : null;
  }
  if (chain.length === 0) return "";
  return chain
    .map((ancestor) => `<button type="button" class="pg-trail-link" data-pg-open="${escapeHtml(ancestor.id)}">${escapeHtml(ancestor.title || "Untitled")}</button>`)
    .join('<span class="pg-trail-sep">›</span>');
}

function autosize(el) {
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

function autosizeAll(root = document) {
  for (const el of $all("textarea.pg-text-input", root)) autosize(el);
}

// ---------------------------------------------------------------- data ----

export async function loadPages() {
  const container = $("#pages-sidebar-tree");
  if (!container) return;
  const session = await fetchJson("/api/web/members?auth=me").catch(() => null);
  pagesState().memberId = session?.connected?.member_id || "";
  const data = await fetchJson(`${PAGES_API}&action=list`);
  pagesState().pages = data.pages || [];
  pagesState().tree = data.tree || [];
  renderSidebar();
}

export async function openPage(id) {
  // Save any pending edits on the current page before switching, otherwise the
  // debounced save would fire against the newly opened page and drop them.
  await flushPendingSave();
  const data = await fetchJson(`${PAGES_API}&action=get&id=${encodeURIComponent(id)}`);
  const page = data.page;
  pagesState().currentId = page.id;
  pagesState().current = page;
  pagesState().working = clone(page.content || []);
  pagesState().dirty = false;
  if (pagesState().working.length === 0) pagesState().working = [newBlock("paragraph")];
  renderSidebar();
  renderEditor();
}

export async function openPageByToken(token) {
  const data = await fetchJson(`${PAGES_API}&action=shared&token=${encodeURIComponent(token)}`);
  pagesState().shared = { page: data.page, breadcrumb: data.breadcrumb || [], linkedPages: data.linkedPages || [] };
  return data;
}

async function createPage(parentId) {
  const data = await postJson(`${PAGES_API}&action=create`, {
    parentId,
    title: parentId ? "Untitled subpage" : "Untitled page",
    content: []
  });
  await loadPages();
  await openPage(data.page.id);
  return data.page;
}

async function createChildPageForBlock(parentPageId) {
  const data = await postJson(`${PAGES_API}&action=create`, {
    parentId: parentPageId,
    title: "Untitled subpage",
    content: []
  });
  pagesState().pages.push(data.page);
  return data.page;
}

// Tracks the in-flight save so overlapping saves cannot drop edits.
let saveInFlight = null;

export async function saveCurrentPage() {
  const current = pagesState().current;
  if (!current || !pagesState().dirty || saveInFlight) return;
  setSaveStatus("Saving…");
  // Snapshot before awaiting: a keystroke during the request must not be lost
  // when the response clears the dirty flag.
  const title = current.title;
  const content = clone(pagesState().working);
  pagesState().dirty = false;
  saveInFlight = postJson(`${PAGES_API}&action=update&id=${encodeURIComponent(current.id)}`, { title, content })
    .then((data) => {
      current.title = data.page.title;
      current.updated_at = data.page.updated_at;
      const listed = findPage(current.id);
      if (listed) { listed.title = data.page.title; listed.updated_at = data.page.updated_at; }
      renderSidebar();
      setSaveStatus("Saved");
    })
    .catch((error) => {
      pagesState().dirty = true;
      showError(error);
    })
    .finally(() => {
      saveInFlight = null;
      // Edits made while the request was in flight were skipped by the guard
      // above, so queue one more save to pick them up.
      if (pagesState().dirty) scheduleSave();
    });
  await saveInFlight;
}

const scheduleSave = debounce(() => { saveCurrentPage().catch(showError); }, 900);

/** Save immediately, e.g. before leaving the tab or closing the page. */
export async function flushPendingSave() {
  if (saveInFlight) await saveInFlight;
  if (pagesState().dirty) await saveCurrentPage();
}

async function removeCurrentPage() {
  const current = pagesState().current;
  if (!current) return;
  const hasChildren = pagesState().pages.some((page) => page.parent_id === current.id);
  const message = hasChildren
    ? `Delete “${current.title}” and all of its subpages? This cannot be undone.`
    : `Delete “${current.title}”? This cannot be undone.`;
  if (!window.confirm(message)) return;
  await postJson(`${PAGES_API}&action=delete&id=${encodeURIComponent(current.id)}`, {});
  pagesState().current = null;
  pagesState().currentId = null;
  pagesState().working = [];
  await loadPages();
  renderEditor();
}

function setSaveStatus(text) {
  const el = $("#pages-save-status");
  if (el) el.textContent = text;
}

function showError(error) {
  setSaveStatus(error instanceof Error ? error.message : String(error));
}

// ------------------------------------------------------------- sidebar ----

function renderSidebar() {
  const container = $("#pages-sidebar-tree");
  if (!container) return;
  const tree = pagesState().tree;
  if (!tree.length) {
    container.innerHTML = '<p class="pg-sidebar-empty">No pages yet. Create the first one.</p>';
    return;
  }
  const expanded = pagesState().expanded;
  container.innerHTML = tree.map((node) => renderNode(node, 0, expanded)).join("");
}

function renderNode(node, depth, expanded) {
  const isOpen = expanded.has(node.id);
  const hasChildren = node.children?.length > 0;
  const active = node.id === pagesState().currentId;
  const chevron = hasChildren
    ? `<button type="button" class="pg-chevron" data-pg-toggle="${escapeHtml(node.id)}" aria-expanded="${isOpen}">${isOpen ? "▾" : "▸"}</button>`
    : '<span class="pg-chevron pg-chevron-empty" aria-hidden="true"></span>';
  const children = hasChildren && isOpen
    ? `<div class="pg-children">${node.children.map((child) => renderNode(child, depth + 1, expanded)).join("")}</div>`
    : "";
  return `
    <div class="pg-node" style="--pg-depth:${depth}">
      <div class="pg-node-row ${active ? "is-active" : ""}">
        ${chevron}
        <button type="button" class="pg-node-link" data-pg-open="${escapeHtml(node.id)}">
          <span class="pg-node-icon">${depth === 0 ? "📁" : "📄"}</span>
          <span class="pg-node-title">${escapeHtml(node.title || "Untitled")}</span>
        </button>
        <button type="button" class="pg-node-add" data-pg-add-child="${escapeHtml(node.id)}" title="Add subpage">＋</button>
      </div>
      ${children}
    </div>
  `;
}

// -------------------------------------------------------------- editor ----

function renderEditor() {
  const container = $("#pages-editor");
  if (!container) return;
  const current = pagesState().current;
  if (!current) {
    container.innerHTML = '<div class="pg-empty">Select a page on the left, or create a new one.</div>';
    return;
  }

  const editable = canEdit(current);
  const trail = parentTrail(current);
  const shareUrl = new URL(window.location.href);
  shareUrl.search = "";
  shareUrl.searchParams.set("page", current.share_token);

  container.innerHTML = `
    ${trail ? `<p class="pg-editor-trail">${trail}</p>` : ""}
    <div class="pg-editor-head">
      <input id="pages-title" class="pg-title" type="text" value="${escapeHtml(current.title)}"
        placeholder="Untitled" ${editable ? "" : "readonly"} />
      <div class="pg-editor-actions">
        <span id="pages-save-status" class="pg-save-status">${editable ? "All changes saved" : `By ${escapeHtml(current.created_by_member_name)}`}</span>
        <button type="button" id="pages-share-btn" class="pg-btn">🔗 Copy link</button>
        ${editable ? '<button type="button" id="pages-delete-btn" class="pg-btn pg-btn-danger">Delete</button>' : ""}
      </div>
    </div>
    ${editable ? "" : '<p class="pg-readonly-note">Only the member who created this page can edit it.</p>'}
    <div class="pg-blocks" id="pages-blocks" contenteditable="false"></div>
    ${editable ? '<button type="button" id="pages-add-block" class="pg-add-block">＋ Add a block</button>' : ""}
  `;

  renderBlocks();
  autosizeAll(container);

  $("#pages-share-btn")?.addEventListener("click", (event) => copyTextToButton(shareUrl.href, event.currentTarget));
  $("#pages-delete-btn")?.addEventListener("click", () => removeCurrentPage().catch(showError));
  $("#pages-add-block")?.addEventListener("click", () => {
    pagesState().working.push(newBlock("paragraph"));
    pagesState().dirty = true;
    renderBlocks();
    scheduleSave();
  });
  const titleEl = $("#pages-title");
  if (titleEl && editable) {
    titleEl.addEventListener("input", () => {
      // Keep the in-memory page in sync so a save triggered after leaving the
      // tab (when the input is gone) still carries the new title.
      pagesState().current.title = titleEl.value;
      pagesState().dirty = true;
      scheduleSave();
    });
  }
}

function renderBlocks() {
  const container = $("#pages-blocks");
  if (!container) return;
  const editable = canEdit(pagesState().current);
  container.innerHTML = pagesState().working.map((block) => renderBlock(block, editable)).join("");
  autosizeAll(container);
}

function blockText(block, editable, placeholder) {
  const cls = block.type === "heading" ? `pg-h pg-h${block.level || 1}` : "pg-text";
  if (!editable) {
    const text = escapeHtml(block.text || "").replace(/\n/g, "<br />");
    return `<div class="${cls} pg-readonly-text">${text}</div>`;
  }
  const hint = placeholder || (block.type === "heading" ? "Heading" : "Write something — type / for commands");
  return `<textarea class="${cls} pg-text-input" rows="1" data-pg-text="${escapeHtml(block.id)}"
    placeholder="${hint}">${escapeHtml(block.text || "")}</textarea>`;
}

function renderBlock(block, editable) {
  if (block.type === "subpage") {
    const child = findPage(block.pageId);
    const title = child ? child.title : "Missing subpage";
    const label = editable
      ? `<button type="button" class="pg-subpage-link" data-pg-open="${escapeHtml(block.pageId || "")}">${escapeHtml(title)}</button>`
      : `<span class="pg-subpage-link pg-subpage-static">${escapeHtml(title)}</span>`;
    return `
      <div class="pg-block pg-block-subpage" data-pg-block="${escapeHtml(block.id)}">
        <span class="pg-subpage-icon">📄</span>
        ${label}
        ${editable ? `<button type="button" class="pg-block-remove" data-pg-remove="${escapeHtml(block.id)}" title="Remove">✕</button>` : ""}
      </div>`;
  }

  if (block.type === "toggle") {
    const collapsed = block.collapsed === true;
    const children = collapsed ? "" : `<div class="pg-toggle-children">${(block.children || []).map((child) => renderBlock(child, editable)).join("")}</div>`;
    return `
      <div class="pg-block pg-block-toggle" data-pg-block="${escapeHtml(block.id)}">
        <div class="pg-toggle-head">
          <button type="button" class="pg-toggle-chevron" data-pg-collapse="${escapeHtml(block.id)}" aria-expanded="${!collapsed}">${collapsed ? "▸" : "▾"}</button>
          ${blockText({ ...block, type: "heading", level: block.level || 2 }, editable, "Toggle heading")}
          ${editable ? `<button type="button" class="pg-block-remove" data-pg-remove="${escapeHtml(block.id)}" title="Remove">✕</button>` : ""}
        </div>
        ${children}
      </div>`;
  }

  return `
    <div class="pg-block" data-pg-block="${escapeHtml(block.id)}">
      ${blockText(block, editable)}
      ${editable ? `<button type="button" class="pg-block-remove" data-pg-remove="${escapeHtml(block.id)}" title="Remove">✕</button>` : ""}
    </div>`;
}

// -------------------------------------------------------- slash commands ----

function hideSlashMenu() {
  $("#pg-slash-menu")?.remove();
}

function showSlashMenu(textarea, blockId) {
  const query = textarea.value.replace(/^\//, "").toLowerCase();
  const matches = SLASH_COMMANDS.filter((item) => item.command.startsWith(query));
  hideSlashMenu();
  if (!matches.length) return;

  const menu = document.createElement("div");
  menu.id = "pg-slash-menu";
  menu.className = "pg-slash-menu";
  menu.innerHTML = matches
    .map((item) => `
      <button type="button" class="pg-slash-item" data-pg-slash="${item.command}">
        <span class="pg-slash-icon">${item.icon}</span>
        <span class="pg-slash-text"><strong>/${item.command}</strong><small>${escapeHtml(item.hint)}</small></span>
      </button>`)
    .join("");

  const rect = textarea.getBoundingClientRect();
  menu.style.left = `${rect.left + window.scrollX}px`;
  menu.style.top = `${rect.bottom + window.scrollY + 4}px`;
  document.body.appendChild(menu);

  menu.addEventListener("click", (event) => {
    const button = event.target.closest("[data-pg-slash]");
    if (!button) return;
    event.preventDefault();
    hideSlashMenu();
    applySlashCommand(blockId, button.dataset.pgSlash).catch(showError);
  });
}

async function applySlashCommand(blockId, command) {
  const found = findBlock(pagesState().working, blockId);
  if (!found) return;
  const { block } = found;

  if (command === "page") {
    const current = pagesState().current;
    const child = await createChildPageForBlock(current.id);
    block.type = "subpage";
    block.text = "";
    block.pageId = child.id;
    delete block.children;
    pagesState().expanded.add(current.id);
    await loadPages();
  } else if (command === "heading") {
    block.type = "toggle";
    block.level = 2;
    block.text = "";
    block.collapsed = false;
    if (!block.children) block.children = [];
  } else if (command === "h1" || command === "h2" || command === "h3") {
    block.type = "heading";
    block.level = Number(command.slice(1));
    block.text = "";
  }

  pagesState().dirty = true;
  renderBlocks();
  renderSidebar();
  scheduleSave();
}

// ------------------------------------------------------------- events ----

function initSidebarEvents() {
  const sidebar = $("#pages-sidebar");
  if (!sidebar) return;

  sidebar.addEventListener("click", (event) => {
    const toggle = event.target.closest("[data-pg-toggle]");
    if (toggle) {
      const id = toggle.dataset.pgToggle;
      if (pagesState().expanded.has(id)) pagesState().expanded.delete(id);
      else pagesState().expanded.add(id);
      renderSidebar();
      return;
    }
    const addChild = event.target.closest("[data-pg-add-child]");
    if (addChild) {
      event.stopPropagation();
      const id = addChild.dataset.pgAddChild;
      pagesState().expanded.add(id);
      createPage(id).catch(showError);
      return;
    }
    const open = event.target.closest("[data-pg-open]");
    if (open) {
      const id = open.dataset.pgOpen;
      if (id) openPage(id).catch(showError);
    }
  });

  $("#pages-new-root")?.addEventListener("click", () => createPage(null).catch(showError));
}

function initEditorEvents() {
  const editor = $("#pages-editor");
  if (!editor) return;

  editor.addEventListener("input", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLTextAreaElement)) return;
    const blockId = target.dataset.pgText;
    const found = findBlock(pagesState().working, blockId);
    if (!found) return;
    found.block.text = target.value;
    pagesState().dirty = true;
    autosize(target);

    if (target.value.startsWith("/") && !target.value.includes("\n")) {
      showSlashMenu(target, blockId);
    } else {
      hideSlashMenu();
    }
    scheduleSave();
  });

  editor.addEventListener("keydown", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLTextAreaElement)) return;
    if (event.key === "Escape") { hideSlashMenu(); return; }
    if (event.key !== "Enter" || event.shiftKey) return;

    // Enter commits the line: a new paragraph goes right after the current block.
    const blockId = target.dataset.pgText;
    const found = findBlock(pagesState().working, blockId);
    if (!found) return;
    if (found.block.type === "heading") return; // headings stay single-line
    event.preventDefault();
    const list = found.block.type === "toggle" ? (found.block.children ??= []) : found.list;
    const at = found.block.type === "toggle" ? list.length : found.index + 1;
    list.splice(at, 0, newBlock("paragraph"));
    pagesState().dirty = true;
    renderBlocks();
    scheduleSave();
    const next = $(`[data-pg-text="${list[at].id}"]`);
    next?.focus();
  });

  editor.addEventListener("click", (event) => {
    const collapse = event.target.closest("[data-pg-collapse]");
    if (collapse) {
      const found = findBlock(pagesState().working, collapse.dataset.pgCollapse);
      if (found) {
        found.block.collapsed = !found.block.collapsed;
        pagesState().dirty = true;
        renderBlocks();
        scheduleSave();
      }
      return;
    }
    const remove = event.target.closest("[data-pg-remove]");
    if (remove) {
      const found = findBlock(pagesState().working, remove.dataset.pgRemove);
      if (found) {
        found.list.splice(found.index, 1);
        if (pagesState().working.length === 0) pagesState().working.push(newBlock("paragraph"));
        pagesState().dirty = true;
        renderBlocks();
        scheduleSave();
      }
      return;
    }
    const open = event.target.closest("[data-pg-open]");
    if (open && open.dataset.pgOpen) openPage(open.dataset.pgOpen).catch(showError);
  });

  document.addEventListener("click", (event) => {
    if (!event.target.closest("#pg-slash-menu") && !event.target.closest("[data-pg-text]")) hideSlashMenu();
  });
}

export function initPages() {
  pagesState().expanded = pagesState().expanded || new Set();
  initSidebarEvents();
  initEditorEvents();
  // Best-effort save if the tab is closed mid-edit.
  window.addEventListener("beforeunload", () => { flushPendingSave(); });
}

// -------------------------------------------------------- shared view ----

/** Read-only rendering of a page opened by its share link (?page=<token>). */
export function renderSharedPage() {
  const container = $("#pages-shared");
  if (!container) return;
  const shared = pagesState().shared;
  if (!shared?.page) {
    container.innerHTML = '<div class="pg-empty">This shared page could not be found.</div>';
    return;
  }
  const { page, breadcrumb } = shared;
  const trail = breadcrumb.length > 1
    ? `<p class="pg-shared-trail">${breadcrumb.map((crumb) => escapeHtml(crumb.title || "Untitled")).join(" › ")}</p>`
    : "";
  container.innerHTML = `
    <article class="pg-shared-card">
      ${trail}
      <h2 class="pg-shared-title">${escapeHtml(page.title || "Untitled")}</h2>
      <p class="pg-shared-meta">Shared by ${escapeHtml(page.created_by_member_name)} · read-only</p>
      <div class="pg-blocks">${(page.content || []).map((block) => renderBlock(block, false)).join("")}</div>
    </article>
  `;
  if (!container.dataset.pgBound) {
    container.dataset.pgBound = "true";
    container.addEventListener("click", (event) => {
      const collapse = event.target.closest("[data-pg-collapse]");
      if (!collapse) return;
      const found = findBlock(pagesState().shared?.page?.content || [], collapse.dataset.pgCollapse);
      if (!found) return;
      found.block.collapsed = !found.block.collapsed;
      renderSharedPage();
    });
  }
}
