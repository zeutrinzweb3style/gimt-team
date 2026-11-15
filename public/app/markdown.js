// Minimal Markdown rendering for the read-only page view.
//
// Page bodies are authored as Markdown: pipe tables for metric figures,
// **bold** figures, headings and bare URLs. The read-only view used to print
// that source verbatim, so a metrics table showed up as a wall of pipes and a
// link was plain text. Everything here escapes its input before adding any
// markup, so a page body can never inject HTML.

import { escapeHtml, safeExternalUrl } from "./utils.js";

const HEADING = /^(#{1,6})\s+(.*)$/;
const UNORDERED = /^\s*[-*+]\s+(.*)$/;
const ORDERED = /^\s*\d+[.)]\s+(.*)$/;
const RULE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;
// A table separator row, e.g. `|---|---:|`. It only ever matters right below a
// header row, so a loose test is safe: pipe + dash + nothing else.
const SEPARATOR_CHARS = /^[\s|:-]+$/;

function isTableRow(line) {
  return line.includes("|");
}

function isSeparator(line) {
  return SEPARATOR_CHARS.test(line) && line.includes("|") && line.includes("-");
}

/** True when `lines[index]` opens a pipe table, i.e. a row over a separator. */
function startsTable(lines, index) {
  return isTableRow(lines[index].trim())
    && index + 1 < lines.length
    && isSeparator(lines[index + 1].trim());
}

/** Split a pipe row into trimmed cells, dropping the optional outer pipes. */
function splitRow(line) {
  let text = line.trim();
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|")) text = text.slice(0, -1);
  return text.split("|").map((cell) => cell.trim());
}

/** Column alignments from a separator row (`:---`, `---:`, `:---:`). */
function columnAlignments(line) {
  return splitRow(line).map((cell) => {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    if (left) return "left";
    return "";
  });
}

/**
 * Bold and emphasis on an already-escaped run of text. Links and code are
 * pulled out before this runs, so a `*` inside a URL is never mistaken for
 * markup.
 */
function applyEmphasis(escaped) {
  return escaped
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
}

function link(href, label) {
  return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
}

/**
 * Inline Markdown on a raw line: `code`, `[label](url)`, bare URLs, then bold
 * and emphasis. URLs are read from the raw text so an `&` in a query string
 * stays an `&` in the href; only the visible label is escaped.
 */
function renderInline(raw) {
  const pattern = /`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?])/g;
  let html = "";
  let last = 0;
  for (const match of String(raw ?? "").matchAll(pattern)) {
    html += applyEmphasis(escapeHtml(raw.slice(last, match.index)));
    if (match[1] !== undefined) {
      html += `<code>${escapeHtml(match[1])}</code>`;
    } else if (match[2] !== undefined) {
      const safe = safeExternalUrl(match[3]);
      html += safe ? link(safe, escapeHtml(match[2])) : escapeHtml(match[0]);
    } else {
      const safe = safeExternalUrl(match[4]);
      html += safe ? link(safe, escapeHtml(match[4])) : escapeHtml(match[4]);
    }
    last = match.index + match[0].length;
  }
  html += applyEmphasis(escapeHtml(String(raw ?? "").slice(last)));
  return html;
}

function renderTable(header, rows, align) {
  const width = Math.max(header.length, ...rows.map((row) => row.length), 0);
  const pad = (row) => {
    const cells = row.slice(0, width);
    while (cells.length < width) cells.push("");
    return cells;
  };
  const style = (index) => (align[index] ? ` style="text-align:${align[index]}"` : "");
  const head = header.length
    ? `<thead><tr>${pad(header).map((cell, i) => `<th${style(i)}>${renderInline(cell)}</th>`).join("")}</tr></thead>`
    : "";
  const body = `<tbody>${rows.map((row) =>
    `<tr>${pad(row).map((cell, i) => `<td${style(i)}>${renderInline(cell)}</td>`).join("")}</tr>`).join("")}</tbody>`;
  return `<div class="pg-md-table-wrap"><table class="pg-md-table">${head}${body}</table></div>`;
}

/**
 * Inline Markdown only, with no block wrapper. Used for a heading block, whose
 * text is a single line and must not be wrapped in a paragraph.
 */
export function renderInlineMarkdown(text) {
  return renderInline(String(text ?? "").replace(/\r?\n/g, " "));
}

/**
 * Render a block of Markdown to safe HTML. Headings, paragraphs, ordered and
 * unordered lists, horizontal rules, pipe tables and inline formatting are
 * supported; anything else is shown as an escaped paragraph.
 */
export function renderMarkdown(text) {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  const html = [];
  let list = null;
  const flushList = () => {
    if (!list) return;
    html.push(`<${list.tag}>${list.items.map((item) => `<li>${item}</li>`).join("")}</${list.tag}>`);
    list = null;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();

    if (!line) { flushList(); i += 1; continue; }

    if (RULE.test(line)) { flushList(); html.push("<hr />"); i += 1; continue; }

    const heading = line.match(HEADING);
    if (heading) {
      flushList();
      const level = Math.min(heading[1].length, 6);
      html.push(`<h${level} class="pg-md-h">${renderInline(heading[2].trim())}</h${level}>`);
      i += 1;
      continue;
    }

    if (startsTable(lines, i)) {
      flushList();
      const header = splitRow(line);
      const align = columnAlignments(lines[i + 1].trim());
      const rows = [];
      i += 2;
      while (i < lines.length && isTableRow(lines[i].trim()) && lines[i].trim()) {
        rows.push(splitRow(lines[i].trim()));
        i += 1;
      }
      html.push(renderTable(header, rows, align));
      continue;
    }

    const unordered = line.match(UNORDERED);
    const ordered = unordered ? null : line.match(ORDERED);
    if (unordered || ordered) {
      const tag = unordered ? "ul" : "ol";
      if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
      list.items.push(renderInline((unordered ? unordered[1] : ordered[1]).trim()));
      i += 1;
      continue;
    }

    flushList();
    const paragraph = [line];
    i += 1;
    while (i < lines.length) {
      const next = lines[i].trim();
      if (!next || HEADING.test(next) || RULE.test(next) || startsTable(lines, i) || UNORDERED.test(next) || ORDERED.test(next)) break;
      paragraph.push(next);
      i += 1;
    }
    html.push(`<p>${renderInline(paragraph.join(" "))}</p>`);
  }

  flushList();
  return html.join("");
}
