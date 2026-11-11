import { escapeHtml, safeExternalUrl, safeImageUrl } from "./utils.js";

// Auto-emoji per domain so members don't have to pick an icon. Falls back to a
// generic link glyph for anything unrecognised.
const DOMAIN_EMOJI = [
  [/(^|\.)(twitter|x)\.com$/i, "🐦"],
  [/(^|\.)t\.me$/i, "✈️"],
  [/(^|\.)telegram\.(me|org|dog)$/i, "✈️"],
  [/(^|\.)github\.com$/i, "🐙"],
  [/(^|\.)linkedin\.com$/i, "💼"],
  [/(^|\.)facebook\.com$/i, "📘"],
  [/(^|\.)instagram\.com$/i, "📸"],
  [/(^|\.)youtube\.com$/i, "▶️"],
  [/(^|\.)youtu\.be$/i, "▶️"],
  [/(^|\.)discord\.(com|gg)$/i, "🎮"],
  [/(^|\.)medium\.com$/i, "✍️"],
  [/(^|\.)reddit\.com$/i, "👽"],
  [/(^|\.)tiktok\.com$/i, "🎵"],
  [/(^|\.)twitch\.tv$/i, "🎥"],
  [/(^|\.)gooddollar\.org$/i, "💚"],
  [/(^|\.)(notion\.so|notion\.site)$/i, "📓"],
  [/(^|\.)calendly\.com$/i, "📅"],
  [/(^|\.)(docs|drive)\.google\.com$/i, "📄"],
  [/(^|\.)spotify\.com$/i, "🎧"],
  [/(^|\.)(behance\.net|dribbble\.com)$/i, "🎨"],
  [/(^|\.)opensea\.io$/i, "🖼️"]
];

export function linkEmoji(url) {
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch (_error) {
    return "🔗";
  }
  for (const [pattern, emoji] of DOMAIN_EMOJI) {
    if (pattern.test(host)) return emoji;
  }
  return "🔗";
}

export function initialsFromName(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

const MONO_GRADIENTS = [
  ["#0d9488", "#0891b2"],
  ["#0ea5e9", "#6366f1"],
  ["#14b8a6", "#22c55e"],
  ["#f59e0b", "#ef4444"],
  ["#8b5cf6", "#ec4899"],
  ["#06b6d4", "#3b82f6"]
];

export function gradientForName(name) {
  let hash = 0;
  const value = String(name || "");
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return MONO_GRADIENTS[hash % MONO_GRADIENTS.length];
}

export function renderAvatar({ name, avatarUrl, size = "md" }) {
  const url = avatarUrl ? safeImageUrl(avatarUrl) : "";
  if (url) {
    return `<span class="avatar avatar-${size}"><img src="${escapeHtml(url)}" alt="${escapeHtml(name || "Member")}" loading="lazy" /></span>`;
  }
  const [from, to] = gradientForName(name);
  return `<span class="avatar avatar-${size} avatar-mono" style="background-image:linear-gradient(135deg, ${from}, ${to})"><span>${escapeHtml(initialsFromName(name))}</span></span>`;
}

function hostFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, "");
  } catch (_error) {
    return "";
  }
}

export function renderBioLinks(links) {
  const safeLinks = (Array.isArray(links) ? links : [])
    .map((link) => ({ label: String(link?.label || "").trim(), url: safeExternalUrl(link?.url) }))
    .filter((link) => link.url);
  if (!safeLinks.length) return "";

  return `<div class="bio-links">${safeLinks
    .map((link) => {
      const host = hostFromUrl(link.url);
      return `<a class="bio-link" href="${escapeHtml(link.url)}" target="_blank" rel="noopener noreferrer">
        <span class="bio-link-emoji">${linkEmoji(link.url)}</span>
        <span class="bio-link-text">
          <span class="bio-link-label">${escapeHtml(link.label || host)}</span>
          <span class="bio-link-host">${escapeHtml(host)}</span>
        </span>
        <span class="bio-link-arrow">→</span>
      </a>`;
    })
    .join("")}</div>`;
}
