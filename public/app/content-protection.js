// Globally enforced content protection for published pages.
//
// A published page is the standalone shared view (`/?page=<token>`) that anyone
// holding the link can open with no login. Its body is locked down by default:
// no text selection, no copy or cut, no right-click menu and no drag, so the
// original formatting, structure and layout cannot be lifted out by ordinary
// means. There is no per-page or per-user switch — protection is part of how a
// published page renders, so existing and newly published pages get it alike.
//
// This is a deterrent, not a guarantee. It stops the ordinary reader from
// copying text and images; it does not, and cannot, defeat screenshots, OCR, the
// browser's own View Source or devtools, a reader with JavaScript disabled, or a
// direct request to the page API. It is deliberately scoped to published
// content: the page editor and the creation UI are never marked, so creators
// keep full selection, copy, paste and drag everywhere they work.

/** Marks a subtree as published content. Set in the shared-page template. */
export const PROTECTED_ATTR = "data-content-protected";

/** What a blocked copy leaves on the clipboard instead of the page content. */
export const BLOCKED_COPY_NOTICE =
  "This page is protected. Copying its content is disabled.";

/** True when `node` sits inside a published-content region. */
export function isProtectedNode(node) {
  if (!node || typeof node.closest !== "function") return false;
  return Boolean(node.closest(`[${PROTECTED_ATTR}]`));
}

/**
 * Navigation and controls keep working: a reader can still right-click a link
 * to open it in a new tab, and the Back control behaves normally. Only the
 * content itself is locked, so a link inside a page body is not a loophole —
 * a copy whose selection covers any protected text is still blocked.
 */
function isInteractiveTarget(node) {
  return Boolean(node?.closest?.("a, button, input, textarea, select, label, [role='button']"));
}

/** True when the live selection starts or ends inside published content. */
function selectionTouchesProtected() {
  const selection = globalThis.getSelection?.();
  if (!selection || selection.rangeCount === 0) return false;
  const container = selection.getRangeAt(0).commonAncestorContainer;
  return isProtectedNode(container?.nodeType === 1 ? container : container?.parentElement);
}

/** The published region an event belongs to, following the selection too. */
function eventHitsProtected(event) {
  return isProtectedNode(event.target) || selectionTouchesProtected();
}

/**
 * Install the document-level guards once. Every handler checks the region the
 * event belongs to and only cancels ordinary extraction inside published
 * content, so the editor, the dashboard tables and the rest of the UI are
 * untouched.
 */
export function initContentProtection(target = globalThis.document) {
  if (!target?.addEventListener || target.dataset?.contentProtectionBound === "true") return;
  if (target.dataset) target.dataset.contentProtectionBound = "true";

  // Right-click, drag and selection are cancelled on the content, but a
  // control (the Back button, a link) keeps its own behaviour.
  const block = (event) => {
    if (isInteractiveTarget(event.target)) return;
    if (!eventHitsProtected(event)) return;
    event.preventDefault();
  };

  // Ctrl+C / Cmd+C and cut: cancel the copy and leave a notice behind, so a
  // reader who expects the content gets nothing usable even if a browser still
  // honoured the keystroke.
  const blockCopy = (event) => {
    if (!eventHitsProtected(event)) return;
    event.preventDefault();
    try {
      event.clipboardData?.setData("text/plain", BLOCKED_COPY_NOTICE);
    } catch (_error) {
      // A browser that refuses the write still had the copy cancelled above.
    }
  };

  target.addEventListener("copy", blockCopy, true);
  target.addEventListener("cut", blockCopy, true);
  target.addEventListener("contextmenu", block, true);
  target.addEventListener("dragstart", block, true);
  target.addEventListener("selectstart", block, true);
}
