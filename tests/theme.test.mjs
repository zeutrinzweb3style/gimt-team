// Guards for the theme tokens in public/styles.css.
//
// The sheet is handwritten and Tailwind is built separately, so nothing else
// catches a `var(--typo)` that silently resolves to nothing, or a token that is
// declared for light mode but forgotten in the `.dark` block.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");

function declarations(block) {
  const found = new Map();
  for (const [, name, value] of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    found.set(name, value.trim());
  }
  return found;
}

function blockFor(selector) {
  const start = css.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `${selector} block is missing from styles.css`);
  const end = css.indexOf("}", start);
  return css.slice(start, end);
}

// Returns the sheet with every `@supports (...) { ... }` block removed, so a
// rule can be checked for existing outside the guard.
function withoutSupports(source) {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const at = source.indexOf("@supports", i);
    if (at === -1) return out + source.slice(i);
    out += source.slice(i, at);
    let depth = 0;
    let j = at;
    for (; j < source.length; j += 1) {
      if (source[j] === "{") depth += 1;
      else if (source[j] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    i = j + 1;
  }
  return out;
}

const light = declarations(blockFor(":root"));
const dark = declarations(blockFor(".dark"));

test("the theme declares a token set for light mode", () => {
  for (const token of ["--brand", "--brand-strong", "--accent-sky", "--accent-violet", "--surface", "--line"]) {
    assert.ok(light.has(token), `${token} is not declared in :root`);
  }
});

test("every light-mode colour token is re-pointed for dark mode", () => {
  // Geometry tokens (radii, spacing) are intentionally theme-independent; only
  // colours need a dark cut.
  const isColour = (value) => /^(rgb|rgba|hsl|hsla|#)/.test(value);
  const missing = [...light.entries()]
    .filter(([, value]) => isColour(value))
    .map(([token]) => token)
    .filter((token) => !dark.has(token));
  assert.deepEqual(missing, [], `dark mode is missing: ${missing.join(", ")}`);
});

test("every var() reference resolves to a declared token", () => {
  // A reference with a comma fallback, like var(--pg-depth, 0), is set inline by
  // the renderer and is deliberately absent from the sheet.
  const referenced = new Set(
    [...css.matchAll(/var\((--[\w-]+)(\s*,)?/g)]
      .filter((m) => !m[2])
      .map((m) => m[1])
  );
  const undeclared = [...referenced].filter((token) => !light.has(token));
  assert.deepEqual(undeclared, [], `undeclared tokens: ${undeclared.join(", ")}`);
});

test("gradient text is behind an @supports guard with a colour fallback", () => {
  // A gradient-clipped heading is transparent, so an unsupported browser would
  // show nothing unless a plain colour is set outside the @supports block.
  const guarded = [...css.matchAll(/@supports \(\(-webkit-background-clip: text\)[^{]+\{/g)];
  assert.ok(guarded.length >= 2, "expected the gradient headings to be guarded");

  const unguarded = withoutSupports(css);
  for (const selector of [".home-directory h3.home-directory-title", ".pg-shared-card .pg-shared-title"]) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const rule = new RegExp(`${escaped}\\s*\\{[^}]*color:\\s*var\\(--brand-strong\\)`);
    assert.match(unguarded, rule, `${selector} needs a plain colour fallback outside the @supports block`);
  }
});
