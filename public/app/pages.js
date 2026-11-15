// Hierarchical pages: a Notion-style tree of pages and nested subpages.
//
// Editing needs a Telegram login and is limited to the member who created the
// page. A single page can also be opened by anyone holding its share link
// (?page=<token>), which the server resolves without a session.

import { state } from "./state.js";
import { $, $all, copyTextToButton, debounce, escapeHtml, fetchJson, postJson, safeImageUrl } from "./utils.js";

const PAGES_API = "/api/web/members?resource=pages";

const SLASH_COMMANDS = [
  { command: "page", label: "Subpage", hint: "Create a nested subpage", icon: "📄" },
  { command: "image", label: "Image", hint: "Upload an image from your device", icon: "🖼" },
  { command: "table", label: "Table", hint: "Grid for metrics and figures", icon: "▦" },
  { command: "heading", label: "Toggle heading", hint: "Collapsible section", icon: "▸" },
  { command: "h1", label: "Heading 1", hint: "Large heading", icon: "H1" },
  { command: "h2", label: "Heading 2", hint: "Medium heading", icon: "H2" },
  { command: "h3", label: "Heading 3", hint: "Small heading", icon: "H3" }
];

const IMAGE_WIDTHS = ["small", "medium", "large", "full"];
const IMAGE_ALIGNS = ["left", "center", "right"];

/** Kept in step with the server ceilings in `src/lib/pages.ts`. */
const TABLE_MAX_ROWS = 100;
const TABLE_MAX_COLUMNS = 20;

const IMAGE_WIDTH_LABEL = { small: "S", medium: "M", large: "L", full: "Full" };
const IMAGE_ALIGN_ICON = { left: "⇤", center: "↔", right: "⇥" };

/** Longest edge (px) an upload is downscaled to before it leaves the browser. */
const IMAGE_MAX_EDGE = 1600;
/** Client-side ceiling, kept under the server's decoded-byte limit. */
const IMAGE_MAX_BYTES = 2.5 * 1024 * 1024;

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

  if (block.type === "image") {
    return renderImageBlock(block, editable);
  }

  if (block.type === "table") {
    return renderTableBlock(block, editable);
  }

  return `
    <div class="pg-block" data-pg-block="${escapeHtml(block.id)}">
      ${blockText(block, editable)}
      ${editable ? `<button type="button" class="pg-block-remove" data-pg-remove="${escapeHtml(block.id)}" title="Remove">✕</button>` : ""}
    </div>`;
}

function renderImageBlock(block, editable) {
  const image = block.image || {};
  const url = safeImageUrl(image.url);
  const width = IMAGE_WIDTHS.includes(image.width) ? image.width : "medium";
  const align = IMAGE_ALIGNS.includes(image.align) ? image.align : "center";
  const alt = escapeHtml(image.alt || block.text || "Page image");
  const id = escapeHtml(block.id);

  const figure = url
    ? `<img class="pg-image" src="${escapeHtml(url)}" alt="${alt}" loading="lazy" />`
    : '<div class="pg-image pg-image-missing">Image unavailable</div>';

  const caption = editable
    ? `<textarea class="pg-image-caption pg-text-input" rows="1" data-pg-caption="${id}"
         placeholder="Add a caption (optional)">${escapeHtml(block.text || "")}</textarea>`
    : (block.text ? `<figcaption class="pg-image-caption pg-readonly-text">${escapeHtml(block.text)}</figcaption>` : "");

  const toolbar = editable
    ? `<div class="pg-image-toolbar">
        <div class="pg-image-group" role="group" aria-label="Image size">
          ${IMAGE_WIDTHS.map((value) => `<button type="button" class="pg-image-btn${value === width ? " is-active" : ""}"
            data-pg-img-width="${value}" data-pg-block-id="${id}" title="Size: ${value}">${IMAGE_WIDTH_LABEL[value]}</button>`).join("")}
        </div>
        <div class="pg-image-group" role="group" aria-label="Image alignment">
          ${IMAGE_ALIGNS.map((value) => `<button type="button" class="pg-image-btn${value === align ? " is-active" : ""}"
            data-pg-img-align="${value}" data-pg-block-id="${id}" title="Align: ${value}">${IMAGE_ALIGN_ICON[value]}</button>`).join("")}
        </div>
        <div class="pg-image-group">
          <button type="button" class="pg-image-btn" data-pg-img-replace="${id}" title="Replace image">Replace</button>
          <button type="button" class="pg-image-btn pg-image-btn-danger" data-pg-remove="${id}" title="Delete image">✕</button>
        </div>
      </div>`
    : "";

  return `
    <div class="pg-block pg-block-image" data-pg-block="${id}">
      <figure class="pg-figure pg-img-w-${width} pg-img-a-${align}">
        ${figure}
        ${caption}
      </figure>
      ${toolbar}
    </div>`;
}

// ------------------------------------------------------------ table block ----

/**
 * A rectangular view of a table block's grid. A block being edited in the
 * browser can be momentarily ragged (a column was just added), so every row is
 * padded to the widest one before rendering.
 */
function tableGrid(block) {
  const rows = Array.isArray(block.table?.rows) ? block.table.rows : [];
  const width = rows.reduce((max, row) => Math.max(max, Array.isArray(row) ? row.length : 0), 0);
  return {
    header: block.table?.header === true,
    width,
    rows: rows.map((row) => {
      const cells = Array.isArray(row) ? row.map((cell) => (typeof cell === "string" ? cell : "")) : [];
      while (cells.length < width) cells.push("");
      return cells;
    })
  };
}

function renderTableBlock(block, editable) {
  const id = escapeHtml(block.id);
  const { header, rows } = tableGrid(block);

  if (!editable) {
    const head = header && rows.length
      ? `<thead><tr>${rows[0].map((cell) => `<th>${escapeHtml(cell)}</th>`).join("")}</tr></thead>`
      : "";
    const bodyRows = header ? rows.slice(1) : rows;
    const body = `<tbody>${bodyRows.map((row) =>
      `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`).join("")}</tbody>`;
    return `
      <div class="pg-block pg-block-table" data-pg-block="${id}">
        <div class="pg-table-wrap"><table class="pg-table">${head}${body}</table></div>
      </div>`;
  }

  const body = rows.map((row, r) =>
    `<tr>${row.map((cell, c) =>
      `<td><input class="pg-table-input" type="text" value="${escapeHtml(cell)}"
        data-pg-cell="${id}:${r}:${c}" aria-label="Row ${r + 1}, column ${c + 1}" /></td>`).join("")}</tr>`
  ).join("");

  return `
    <div class="pg-block pg-block-table" data-pg-block="${id}">
      <div class="pg-table-wrap"><table class="pg-table pg-table-editing">${body}</table></div>
      <div class="pg-table-toolbar">
        <button type="button" class="pg-table-btn" data-pg-table-row="${id}" title="Add a row">＋ Row</button>
        <button type="button" class="pg-table-btn" data-pg-table-col="${id}" title="Add a column">＋ Column</button>
        <button type="button" class="pg-table-btn${header ? " is-active" : ""}" data-pg-table-header="${id}"
          aria-pressed="${header}" title="Toggle header row">Header</button>
        <button type="button" class="pg-table-btn pg-table-btn-danger" data-pg-remove="${id}" title="Delete table">✕</button>
      </div>
    </div>`;
}

// ------------------------------------------------------------ image upload ----

/** Hidden file input reused for both "add image" and "replace image". */
let imagePicker = null;
let imagePickerTarget = null;

function pickImage(blockId) {
  if (!imagePicker) {
    imagePicker = document.createElement("input");
    imagePicker.type = "file";
    imagePicker.accept = "image/png,image/jpeg,image/gif,image/webp";
    imagePicker.style.display = "none";
    imagePicker.addEventListener("change", () => {
      const file = imagePicker.files?.[0];
      const target = imagePickerTarget;
      imagePicker.value = "";
      imagePickerTarget = null;
      if (file && target) uploadImageIntoBlock(target, file).catch(showError);
    });
    document.body.appendChild(imagePicker);
  }
  imagePickerTarget = blockId;
  imagePicker.click();
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Could not read that file."));
    reader.readAsDataURL(file);
  });
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("That file is not a readable image."));
    img.src = dataUrl;
  });
}

/**
 * Downscale in the browser so a photo straight off a phone fits under the
 * upload limit. Keeps the original when it is already small or when the canvas
 * round-trip would only make it bigger (e.g. an optimised PNG).
 */
async function toUploadDataUrl(file) {
  const original = await readFileAsDataUrl(file);
  if (original.length <= IMAGE_MAX_BYTES) return original;

  const img = await loadImage(original);
  const scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(img.width, img.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(img.width * scale));
  canvas.height = Math.max(1, Math.round(img.height * scale));
  canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);

  const resized = canvas.toDataURL("image/jpeg", 0.85);
  return resized.length < original.length ? resized : original;
}

async function uploadImageIntoBlock(blockId, file) {
  const found = findBlock(pagesState().working, blockId);
  if (!found) return;
  setSaveStatus("Uploading image…");

  const data = await toUploadDataUrl(file);
  const pageId = pagesState().current?.id || "";
  const result = await postJson(`${PAGES_API}&action=upload-image&id=${encodeURIComponent(pageId)}`, { data });
  const image = result?.image;
  if (!image?.url) throw new Error("The upload did not return an image URL.");

  const existing = found.block.image || {};
  found.block.type = "image";
  found.block.image = {
    url: image.url,
    bucket: image.bucket || "",
    path: image.path || "",
    width: IMAGE_WIDTHS.includes(existing.width) ? existing.width : "medium",
    align: IMAGE_ALIGNS.includes(existing.align) ? existing.align : "center"
  };
  pagesState().dirty = true;
  renderBlocks();
  renderSidebar();
  await saveCurrentPage();
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
    pagesState().dirty = true;
    renderBlocks();
    renderSidebar();
    // Persist the parent's new subpage block before leaving it, so the link
    // survives even if the user never comes back to this page.
    await flushPendingSave();
    await loadPages();
    // Land the user on the new subpage so they can name it right away. Its
    // title then shows on the parent's block, and the same holds for every
    // page created this way.
    await openPage(child.id);
    const titleEl = $("#pages-title");
    if (titleEl instanceof HTMLInputElement) {
      titleEl.focus();
      titleEl.select();
    }
    return;
  } else if (command === "image") {
    // The file dialog is async; the picker resolves the block once a file is
    // chosen, so nothing else to do here.
    block.text = "";
    pagesState().dirty = true;
    renderBlocks();
    pickImage(blockId);
    return;
  } else if (command === "table") {
    block.type = "table";
    block.text = "";
    block.table = { rows: [["", ""], ["", ""]], header: true };
    delete block.children;
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

    // A table cell is a plain input, keyed "<blockId>:<row>:<column>".
    const cellKey = target instanceof HTMLInputElement ? target.dataset.pgCell : undefined;
    if (cellKey) {
      const [blockId, row, column] = cellKey.split(":");
      const found = findBlock(pagesState().working, blockId);
      const cell = found?.block.table?.rows?.[Number(row)];
      if (!cell) return;
      cell[Number(column)] = target.value;
      pagesState().dirty = true;
      scheduleSave();
      return;
    }

    if (!(target instanceof HTMLTextAreaElement)) return;

    const captionId = target.dataset.pgCaption;
    if (captionId) {
      const found = findBlock(pagesState().working, captionId);
      if (!found) return;
      found.block.text = target.value;
      pagesState().dirty = true;
      autosize(target);
      scheduleSave();
      return;
    }

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
    const addRow = event.target.closest("[data-pg-table-row]");
    if (addRow) {
      const found = findBlock(pagesState().working, addRow.dataset.pgTableRow);
      const table = found?.block.table;
      if (table && table.rows.length < TABLE_MAX_ROWS) {
        table.rows.push(new Array(table.rows[0]?.length || 1).fill(""));
        pagesState().dirty = true;
        renderBlocks();
        scheduleSave();
      }
      return;
    }
    const addCol = event.target.closest("[data-pg-table-col]");
    if (addCol) {
      const found = findBlock(pagesState().working, addCol.dataset.pgTableCol);
      const table = found?.block.table;
      if (table && (table.rows[0]?.length || 0) < TABLE_MAX_COLUMNS) {
        for (const row of table.rows) row.push("");
        pagesState().dirty = true;
        renderBlocks();
        scheduleSave();
      }
      return;
    }
    const headerBtn = event.target.closest("[data-pg-table-header]");
    if (headerBtn) {
      const found = findBlock(pagesState().working, headerBtn.dataset.pgTableHeader);
      if (found?.block.table) {
        found.block.table.header = !found.block.table.header;
        pagesState().dirty = true;
        renderBlocks();
        scheduleSave();
      }
      return;
    }
    const widthBtn = event.target.closest("[data-pg-img-width]");
    if (widthBtn) {
      const found = findBlock(pagesState().working, widthBtn.dataset.pgBlockId);
      if (found?.block.image) {
        found.block.image.width = widthBtn.dataset.pgImgWidth;
        pagesState().dirty = true;
        renderBlocks();
        scheduleSave();
      }
      return;
    }
    const alignBtn = event.target.closest("[data-pg-img-align]");
    if (alignBtn) {
      const found = findBlock(pagesState().working, alignBtn.dataset.pgBlockId);
      if (found?.block.image) {
        found.block.image.align = alignBtn.dataset.pgImgAlign;
        pagesState().dirty = true;
        renderBlocks();
        scheduleSave();
      }
      return;
    }
    const replaceBtn = event.target.closest("[data-pg-img-replace]");
    if (replaceBtn) {
      pickImage(replaceBtn.dataset.pgImgReplace);
      return;
    }
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
