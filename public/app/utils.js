export const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const DOW_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function $(selector, root = document) { return root.querySelector(selector); }

export function $all(selector, root = document) { return Array.from(root.querySelectorAll(selector)); }

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  }[ch]));
}

export function safeExternalUrl(value) {
  try {
    const url = new URL(String(value));
    return ["http:", "https:"].includes(url.protocol) ? url.href : "";
  } catch (_error) {
    return "";
  }
}

export function safeImageUrl(value) {
  try {
    const raw = String(value ?? "");
    const url = new URL(raw, window.location.origin);
    if (!["http:", "https:"].includes(url.protocol)) return "";
    if (raw.startsWith("/") && url.origin !== window.location.origin) return "";
    return url.href;
  } catch (_error) {
    return "";
  }
}

export function linkifyProofContent(value) {
  const text = String(value ?? "");
  const urlPattern = /https?:\/\/[^\s<>()]+[^\s<>().,;:!?]/gi;
  let html = "";
  let lastIndex = 0;
  for (const match of text.matchAll(urlPattern)) {
    const urlText = match[0];
    const index = match.index ?? 0;
    html += escapeHtml(text.slice(lastIndex, index));
    const safeUrl = safeExternalUrl(urlText);
    html += safeUrl
      ? `<a href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener noreferrer" class="text-blue-600 hover:underline dark:text-blue-300 break-all">${escapeHtml(urlText)}</a>`
      : escapeHtml(urlText);
    lastIndex = index + urlText.length;
  }
  html += escapeHtml(text.slice(lastIndex));
  return html;
}

export function renderProofAttachments(row) {
  const attachments = Array.isArray(row.attachments) ? row.attachments : [];
  const photos = attachments.filter((attachment) => attachment && attachment.type === "photo" && safeImageUrl(attachment.url));
  if (!photos.length) return "";

  return `
    <div class="mt-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
      ${photos.map((attachment, index) => {
        const imageUrl = safeImageUrl(attachment.url);
        return `
          <a href="${escapeHtml(imageUrl)}" target="_blank" rel="noopener noreferrer" class="block rounded-md border border-slate-200 dark:border-slate-700 overflow-hidden bg-white dark:bg-slate-900">
            <img src="${escapeHtml(imageUrl)}" alt="Proof of work screenshot ${index + 1}" loading="lazy" class="max-h-72 w-full object-contain bg-slate-100 dark:bg-slate-950" />
            <div class="px-2 py-1 text-[11px] text-blue-600 dark:text-blue-300">Open screenshot ${index + 1}</div>
          </a>
        `;
      }).join("")}
    </div>
  `;
}

export function decodeHtmlEntities(value) {
  const textarea = document.createElement("textarea");
  textarea.innerHTML = String(value ?? "");
  return textarea.value;
}

export function ticketMessageDisplayText(value) {
  return String(value ?? "")
    .replace(/<a\b[^>]*\bhref\s*=\s*(["'])tg:\/\/user\?id=\d+\1[^>]*>([\s\S]*?)<\/a>/gi, (_match, _quote, label) =>
      decodeHtmlEntities(String(label).replace(/<[^>]*>/g, ""))
    )
    .replace(/tg:\/\/user\?id=\d+/gi, "Telegram user");
}

export function fmtTimeUtc(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().replace("T", " ").slice(0, 16) + "Z";
}

export function fmtRelative(iso) {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

export function fmtDateHuman(workDateUtc) {
  if (!workDateUtc) return "—";
  const d = new Date(`${workDateUtc}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return workDateUtc;
  return `${MONTH_SHORT[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()} (${DOW_SHORT[d.getUTCDay()]})`;
}

export function pill(cls, text) {
  return `<span class="pill ${cls}">${escapeHtml(text)}</span>`;
}

export function memberLink(memberId, memberName) {
  if (!memberId) return escapeHtml(memberName);
  return `<button type="button" class="member-link" data-member-id="${escapeHtml(memberId)}" data-member-name="${escapeHtml(memberName)}">${escapeHtml(memberName)}</button>`;
}

export function groupName(row) {
  return row.group_title || `Chat ${row.telegram_chat_id}`;
}

export function groupPill(row) {
  return `<span class="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 mono" title="${escapeHtml(row.telegram_chat_id)}">${escapeHtml(groupName(row))}</span>`;
}

export function compareValues(a, b) {
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
}

export function applySortIndicators(tableSelector, sortKey, ascending) {
  for (const th of $all(`${tableSelector} thead th`)) {
    const key = th.dataset.sortKey;
    if (!key) continue;
    const indicator = th.querySelector(".sort-indicator");
    if (key === sortKey) {
      th.setAttribute("aria-sort", ascending ? "ascending" : "descending");
      if (indicator) indicator.textContent = ascending ? "▲" : "▼";
    } else {
      th.removeAttribute("aria-sort");
      if (indicator) indicator.textContent = "↕";
    }
  }
}

export function wireSorting(tableSelector, sortRef, rerender) {
  for (const th of $all(`${tableSelector} thead th`)) {
    th.addEventListener("click", () => {
      const key = th.dataset.sortKey;
      if (!key) return;
      if (sortRef.key === key) {
        sortRef.ascending = !sortRef.ascending;
      } else {
        sortRef.key = key;
        sortRef.ascending = true;
      }
      rerender();
    });
  }
}

export async function fetchJson(path) {
  const r = await fetch(path, { headers: { accept: "application/json" } });
  if (!r.ok) {
    const deployHint = r.status === 404 && path.startsWith("/api/")
      ? " (API route not found. On Netlify, make sure netlify.toml and netlify/functions are deployed from the repository root; on Vercel, make sure the /api folder is included.)"
      : "";
    throw new Error(`${path} → ${r.status}${deployHint}`);
  }
  const body = await r.json();
  if (body && body.ok === false) throw new Error(body.error || "Request failed");
  return body;
}

export function setLastUpdated() {
  $("#last-updated").textContent = `Updated ${new Date().toLocaleTimeString()}`;
}

export function toIsoDate(date) {
  return date.toISOString().slice(0, 10);
}

export function utcDay(d) {
  const day = d.getUTCDay();
  return day === 0 ? 7 : day; // make Sunday = 7
}

export function isoWeekStart(date) {
  // Returns the Monday 00:00 UTC of date's ISO week.
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = utcDay(d);
  d.setUTCDate(d.getUTCDate() - (day - 1));
  return d;
}

export function isoWeekEnd(start) {
  const end = new Date(start.getTime());
  end.setUTCDate(end.getUTCDate() + 6);
  return end;
}

export function isoWeekKey(date) {
  const start = isoWeekStart(date);
  return start.toISOString().slice(0, 10); // YYYY-MM-DD of Monday
}

export function weekKeyFromIso(iso) {
  return isoWeekKey(new Date(iso));
}

export function weekKeyFromDateString(workDateUtc) {
  return isoWeekKey(new Date(`${workDateUtc}T00:00:00Z`));
}

export function currentWeekKey() {
  return isoWeekKey(new Date());
}

export function fmtWeekLabel(weekKey) {
  const start = new Date(`${weekKey}T00:00:00Z`);
  const end = isoWeekEnd(start);
  const sameMonth = start.getUTCMonth() === end.getUTCMonth();
  const startStr = `${MONTH_SHORT[start.getUTCMonth()]} ${start.getUTCDate()}`;
  const endStr = sameMonth
    ? `${end.getUTCDate()}`
    : `${MONTH_SHORT[end.getUTCMonth()]} ${end.getUTCDate()}`;
  return `${startStr}–${endStr}, ${end.getUTCFullYear()}`;
}

export function groupByWeek(rows, keyFn) {
  const map = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return map;
}

export function debounce(fn, delay = 350) {
  let timeout = null;
  return (...args) => {
    window.clearTimeout(timeout);
    timeout = window.setTimeout(() => fn(...args), delay);
  };
}

export function copyTextToButton(link, btn, successText = "Link copied!") {
  if (!link) return;
  const originalText = btn?.textContent || "Copy link";
  const onDone = (ok) => {
    if (!btn) return;
    btn.textContent = ok ? successText : "Copy failed";
    setTimeout(() => { btn.textContent = originalText; }, 2000);
  };
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(link).then(() => onDone(true), () => fallbackCopyText(link, onDone));
  } else {
    fallbackCopyText(link, onDone);
  }
}

function fallbackCopyText(text, onDone) {
  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(textarea);
    onDone(ok);
  } catch (_error) {
    onDone(false);
  }
}
