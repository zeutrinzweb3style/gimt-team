// Integration tests for the hierarchical-pages API.
//
// The real handler in api/web/members.js runs against a stub of global fetch
// that emulates the Supabase PostgREST endpoints. That means the session check,
// the creator-only ownership rule, share-token reads, sanitisation and the
// cascade on delete all execute as they do in production. Only the network
// boundary is stubbed.

import assert from "node:assert/strict";
import { test } from "node:test";

process.env.TELEGRAM_BOT_TOKEN = "123456:test-token-for-sessions";
process.env.SESSION_SECRET = "test-session-secret";
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";

// --------------------------------------------------- Supabase REST emulation --

let store = { pages: [] };
let uploads = [];
let idSeq = 0;

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return data; },
    async text() { return JSON.stringify(data); }
  };
}

function matches(row, searchParams) {
  for (const [key, value] of searchParams.entries()) {
    if (["select", "order", "limit", "on_conflict"].includes(key)) continue;
    if (value.startsWith("eq.")) {
      if (String(row[key]) !== value.slice(3)) return false;
    } else if (value.startsWith("is.null")) {
      if (row[key] !== null && row[key] !== undefined) return false;
    } else if (value.startsWith("in.(")) {
      const list = value.slice(4, -1).split(",");
      if (!list.includes(String(row[key]))) return false;
    }
  }
  return true;
}

function defaultRow(payload) {
  idSeq += 1;
  return {
    id: payload.id || `00000000-0000-4000-8000-${String(idSeq).padStart(12, "0")}`,
    parent_id: payload.parent_id ?? null,
    title: payload.title ?? "",
    content: payload.content ?? [],
    share_token: payload.share_token,
    created_by_member_id: payload.created_by_member_id,
    created_by_member_name: payload.created_by_member_name,
    created_at: payload.created_at || new Date(Date.now() + idSeq).toISOString(),
    updated_at: payload.updated_at || new Date().toISOString(),
    updated_by_member_id: payload.updated_by_member_id ?? null
  };
}

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  const method = (init.method || "GET").toUpperCase();

  // Storage endpoints are not PostgREST. Record each upload so a test can assert
  // the object was stored, and answer like the real bucket would.
  if (url.pathname.startsWith("/storage/v1/")) {
    if (method === "POST" && url.pathname.startsWith("/storage/v1/object/")) {
      uploads.push({
        path: url.pathname,
        bytes: Buffer.isBuffer(init.body) ? init.body.length : 0,
        contentType: init.headers?.["content-type"]
      });
    }
    return jsonResponse({ Key: url.pathname }, 200);
  }

  const table = url.pathname.replace("/rest/v1/", "");
  const rows = store[table] || (store[table] = []);
  const searchParams = url.searchParams;

  if (method === "GET") {
    let found = rows.filter((row) => matches(row, searchParams));
    const orderParam = searchParams.get("order");
    if (orderParam) {
      const [field, dir] = orderParam.split(".");
      found = [...found].sort((a, b) => (a[field] > b[field] ? 1 : a[field] < b[field] ? -1 : 0));
      if (dir === "desc") found.reverse();
    }
    const selected = searchParams.get("select");
    return jsonResponse(found.map((row) => selected && selected !== "*"
      ? Object.fromEntries(selected.split(",").map((field) => [field, row[field]]))
      : { ...row }));
  }

  if (method === "POST") {
    const payload = JSON.parse(init.body);
    const list = Array.isArray(payload) ? payload : [payload];
    const created = list.map((row) => defaultRow(row));
    rows.push(...created);
    return jsonResponse(created.map((row) => ({ ...row })), 201);
  }

  if (method === "PATCH") {
    const payload = JSON.parse(init.body);
    const touched = [];
    for (let i = 0; i < rows.length; i += 1) {
      if (matches(rows[i], searchParams)) {
        rows[i] = { ...rows[i], ...payload };
        touched.push({ ...rows[i] });
      }
    }
    return jsonResponse(touched);
  }

  if (method === "DELETE") {
    const doomed = new Set(rows.filter((row) => matches(row, searchParams)).map((row) => row.id));
    // Emulate the schema's ON DELETE CASCADE from pages.parent_id.
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of rows) {
        if (row.parent_id && doomed.has(row.parent_id) && !doomed.has(row.id)) {
          doomed.add(row.id);
          changed = true;
        }
      }
    }
    store[table] = rows.filter((row) => !doomed.has(row.id));
    return { ok: true, status: 204, async json() { return null; }, async text() { return ""; } };
  }

  throw new Error(`unexpected ${method} ${url.pathname}`);
};

const { createSessionCookie, SESSION_COOKIE } = await import("../.test-build/src/lib/telegram-auth.js");
const handler = (await import("../.test-build/api/web/members.js")).default;

// ----------------------------------------------------------------- helpers --

function makeResponse() {
  const headers = {};
  return {
    statusCode: 200,
    body: "",
    setHeader(name, value) { headers[name.toLowerCase()] = value; },
    getHeader(name) { return headers[name.toLowerCase()]; },
    end(payload) { this.body = payload === undefined ? "" : String(payload); },
    json() { return JSON.parse(this.body); }
  };
}

function makeRequest(url, { method = "GET", body, cookie, headers = {} } = {}) {
  return {
    method,
    url,
    headers: cookie ? { cookie, ...headers } : { ...headers },
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body));
    }
  };
}

async function call(url, options) {
  const response = makeResponse();
  await handler(makeRequest(url, options), response);
  return response;
}

async function sessionCookie(memberId, memberName) {
  const value = await createSessionCookie(
    { telegramUserId: 900000 + memberId.length, memberId, memberName, exp: Math.floor(Date.now() / 1000) + 3600 },
    process.env.SESSION_SECRET
  );
  return `${SESSION_COOKIE}=${encodeURIComponent(value)}`;
}

const API = "/api/web/members?resource=pages";
const resetStore = () => { store = { pages: [] }; uploads = []; idSeq = 0; };

// A 1x1 PNG, the smallest valid image for the upload tests.
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG_BYTES = Buffer.from(PNG_BASE64, "base64");

// -------------------------------------------------------------------- tests --

test("the tree requires a login", async () => {
  resetStore();
  const response = await call(`${API}&action=list`);
  assert.equal(response.statusCode, 401);
  assert.equal(response.json().ok, false);
});

test("a signed-in member creates a page and sees it in the tree", async () => {
  resetStore();
  const cookie = await sessionCookie("betz", "Betz");
  const created = await call(`${API}&action=create`, {
    method: "POST", cookie,
    body: { title: "Main Project Report", content: [{ id: "b1", type: "paragraph", text: "Hello" }] }
  });
  assert.equal(created.statusCode, 201);
  assert.match(created.json().page.share_token, /^[0-9a-f]{32}$/);

  const list = await call(`${API}&action=list`, { cookie });
  assert.equal(list.json().pages.length, 1);
  assert.equal(list.json().tree[0].title, "Main Project Report");
  assert.deepEqual(list.json().member, { member_id: "betz", member_name: "Betz" });
  assert.equal("content" in list.json().pages[0], false);
  assert.equal("share_token" in list.json().pages[0], false);
});

test("every member sees all pages, but only the creator can edit one", async () => {
  resetStore();
  const owner = await sessionCookie("betz", "Betz");
  const other = await sessionCookie("omar", "Omar");

  const id = (await call(`${API}&action=create`, {
    method: "POST", cookie: owner, body: { title: "Shared plan", content: [] }
  })).json().page.id;

  // The other member can see it (option B) ...
  const seen = await call(`${API}&action=list`, { cookie: other });
  assert.equal(seen.json().pages.length, 1);

  // ... but cannot edit or delete it.
  assert.equal((await call(`${API}&action=update&id=${id}`, { method: "POST", cookie: other, body: { title: "Hijacked" } })).statusCode, 403);
  assert.equal((await call(`${API}&action=delete&id=${id}`, { method: "POST", cookie: other })).statusCode, 403);

  const renamed = await call(`${API}&action=update&id=${id}`, { method: "POST", cookie: owner, body: { title: "Renamed" } });
  assert.equal(renamed.statusCode, 200);
  assert.equal(renamed.json().page.title, "Renamed");
});

test("nested subpages keep their parent", async () => {
  resetStore();
  const cookie = await sessionCookie("betz", "Betz");
  const root = (await call(`${API}&action=create`, { method: "POST", cookie, body: { title: "July", content: [] } })).json().page;
  const week = (await call(`${API}&action=create`, { method: "POST", cookie, body: { parentId: root.id, title: "Week 1", content: [] } })).json().page;
  assert.equal(week.parent_id, root.id);

  const tree = (await call(`${API}&action=list`, { cookie })).json().tree;
  assert.equal(tree.length, 1);
  assert.equal(tree[0].children[0].title, "Week 1");
});

test("deleting a page cascades to its subpages", async () => {
  resetStore();
  const cookie = await sessionCookie("betz", "Betz");
  const root = (await call(`${API}&action=create`, { method: "POST", cookie, body: { title: "Root", content: [] } })).json().page;
  const child = (await call(`${API}&action=create`, { method: "POST", cookie, body: { parentId: root.id, title: "Child", content: [] } })).json().page;
  await call(`${API}&action=create`, { method: "POST", cookie, body: { parentId: child.id, title: "Grandchild", content: [] } });

  assert.equal((await call(`${API}&action=delete&id=${root.id}`, { method: "POST", cookie })).json().deleted, 3);
  assert.equal((await call(`${API}&action=list`, { cookie })).json().pages.length, 0);
});

test("a share link opens the page with no login", async () => {
  resetStore();
  const cookie = await sessionCookie("betz", "Betz");
  const page = (await call(`${API}&action=create`, {
    method: "POST", cookie, body: { title: "Shared report", content: [{ id: "t", type: "toggle", level: 2, text: "July", children: [] }] }
  })).json().page;

  const shared = await call(`${API}&action=shared&token=${page.share_token}`);
  assert.equal(shared.statusCode, 200);
  assert.equal(shared.json().page.title, "Shared report");
  assert.equal(shared.json().breadcrumb.at(-1).title, "Shared report");
});

test("a shared subpage link reports the linked subpage titles", async () => {
  resetStore();
  const cookie = await sessionCookie("betz", "Betz");
  const root = (await call(`${API}&action=create`, { method: "POST", cookie, body: { title: "Parent", content: [] } })).json().page;
  const child = (await call(`${API}&action=create`, { method: "POST", cookie, body: { parentId: root.id, title: "Child Doc", content: [] } })).json().page;
  await call(`${API}&action=update&id=${root.id}`, {
    method: "POST", cookie, body: { content: [{ id: "s", type: "subpage", pageId: child.id }] }
  });

  const shared = await call(`${API}&action=shared&token=${root.share_token}`);
  assert.equal(shared.statusCode, 200);
  // A shared reader has no page list, so the linked subpage carries its own
  // share token: that is what lets the subpage block open on the shared page.
  assert.deepEqual(shared.json().linkedPages, [{ id: child.id, title: "Child Doc", share_token: child.share_token }]);
  assert.deepEqual(shared.json().breadcrumb.map((crumb) => crumb.title), ["Parent"]);
});

test("the shared subpage link is openable without a login", async () => {
  resetStore();
  const cookie = await sessionCookie("betz", "Betz");
  const root = (await call(`${API}&action=create`, { method: "POST", cookie, body: { title: "Parent", content: [] } })).json().page;
  const child = (await call(`${API}&action=create`, { method: "POST", cookie, body: { parentId: root.id, title: "Child Doc", content: [{ id: "p", type: "paragraph", text: "Body" }] } })).json().page;
  await call(`${API}&action=update&id=${root.id}`, {
    method: "POST", cookie, body: { content: [{ id: "s", type: "subpage", pageId: child.id }] }
  });

  const token = (await call(`${API}&action=shared&token=${root.share_token}`)).json().linkedPages[0].share_token;
  const opened = await call(`${API}&action=shared&token=${token}`);
  assert.equal(opened.statusCode, 200);
  assert.equal(opened.json().page.title, "Child Doc");
  assert.equal(opened.json().page.content[0].text, "Body");
});

test("a page can be moved under a new parent", async () => {
  resetStore();
  const cookie = await sessionCookie("betz", "Betz");
  const root = (await call(`${API}&action=create`, { method: "POST", cookie, body: { title: "Root", content: [] } })).json().page;
  const other = (await call(`${API}&action=create`, { method: "POST", cookie, body: { title: "Other", content: [] } })).json().page;
  const child = (await call(`${API}&action=create`, { method: "POST", cookie, body: { parentId: root.id, title: "Child", content: [] } })).json().page;

  const moved = await call(`${API}&action=update&id=${child.id}`, { method: "POST", cookie, body: { parentId: other.id } });
  assert.equal(moved.statusCode, 200);
  assert.equal(moved.json().page.parent_id, other.id);

  const tree = (await call(`${API}&action=list`, { cookie })).json().tree;
  const movedNode = tree.find((node) => node.id === other.id)?.children?.find((node) => node.id === child.id);
  assert.ok(movedNode, "the child should appear under its new parent in the tree");
});

test("a bad share token is rejected", async () => {
  resetStore();
  assert.equal((await call(`${API}&action=shared&token=nope`)).statusCode, 400);
  assert.equal((await call(`${API}&action=shared&token=${"a".repeat(32)}`)).statusCode, 404);
});

test("a page cannot be moved inside its own descendant", async () => {
  resetStore();
  const cookie = await sessionCookie("betz", "Betz");
  const root = (await call(`${API}&action=create`, { method: "POST", cookie, body: { title: "Root", content: [] } })).json().page;
  const child = (await call(`${API}&action=create`, { method: "POST", cookie, body: { parentId: root.id, title: "Child", content: [] } })).json().page;
  assert.equal((await call(`${API}&action=update&id=${root.id}`, { method: "POST", cookie, body: { parentId: child.id } })).statusCode, 400);
});

test("blocks are sanitised on save", async () => {
  resetStore();
  const cookie = await sessionCookie("betz", "Betz");
  const page = (await call(`${API}&action=create`, {
    method: "POST", cookie,
    body: {
      title: "Doc",
      content: [
        { id: "keep", type: "paragraph", text: "hello" },
        { id: "drop", type: "script", text: "alert(1)" },
        { id: "empty", type: "paragraph", text: "   " },
        { id: "h", type: "toggle", level: 9, text: "Section", collapsed: true, children: [{ id: "c", type: "paragraph", text: "body" }] }
      ]
    }
  })).json().page;

  assert.deepEqual(page.content.map((b) => b.id), ["keep", "h"]);
  assert.equal(page.content[1].level, undefined);
  assert.equal(page.content[1].collapsed, true);
  assert.equal(page.content[1].children[0].text, "body");
});

test("an unknown action is rejected and existing routes still work", async () => {
  resetStore();
  const cookie = await sessionCookie("betz", "Betz");
  assert.equal((await call(`${API}&action=bogus`, { cookie })).statusCode, 400);

  const me = await call("/api/web/members?auth=me");
  assert.equal(me.statusCode, 200);
  assert.equal(me.json().connected, null);
});

test("a tampered session cookie is rejected", async () => {
  resetStore();
  assert.equal((await call(`${API}&action=list`, { cookie: `${SESSION_COOKIE}=forged.value` })).statusCode, 401);
});

// ----------------------------------------------------------- image blocks --

test("an image block keeps a safe url and normalises width and alignment", async () => {
  resetStore();
  const cookie = await sessionCookie("betz", "Betz");
  const created = await call(`${API}&action=create`, {
    method: "POST", cookie,
    body: {
      title: "Tutorial",
      content: [
        { id: "img1", type: "image", text: "Signup screen", image: { url: "https://cdn.example.com/a.png", width: "large", align: "right" } },
        { id: "img2", type: "image", text: "", image: { url: "https://cdn.example.com/b.png", width: "huge", align: "diagonal" } }
      ]
    }
  });

  assert.equal(created.statusCode, 201);
  const [first, second] = created.json().page.content;
  assert.equal(first.type, "image");
  assert.equal(first.text, "Signup screen");
  assert.equal(first.image.width, "large");
  assert.equal(first.image.align, "right");
  // Unknown enum values fall back to the defaults rather than being stored.
  assert.equal(second.image.width, "medium");
  assert.equal(second.image.align, "center");
});

test("an image block with a javascript: url is dropped", async () => {
  resetStore();
  const cookie = await sessionCookie("betz", "Betz");
  const created = await call(`${API}&action=create`, {
    method: "POST", cookie,
    body: {
      title: "Tutorial",
      content: [
        { id: "evil", type: "image", text: "x", image: { url: "javascript:alert(1)", width: "full", align: "center" } },
        { id: "ok", type: "image", text: "", image: { url: "https://cdn.example.com/ok.png" } },
        { id: "empty", type: "image", text: "", image: { url: "" } }
      ]
    }
  });

  const ids = created.json().page.content.map((b) => b.id);
  assert.deepEqual(ids, ["ok"]);
  assert.equal(created.json().page.content[0].image.width, "medium");
});

test("an image block survives a round trip through update", async () => {
  resetStore();
  const cookie = await sessionCookie("betz", "Betz");
  const id = (await call(`${API}&action=create`, {
    method: "POST", cookie, body: { title: "Tutorial", content: [] }
  })).json().page.id;

  const updated = await call(`${API}&action=update&id=${id}`, {
    method: "PATCH", cookie,
    body: {
      content: [{
        id: "img1", type: "image", text: "Step 1 screenshot",
        image: { url: "https://cdn.example.com/step1.png", bucket: "page-images", path: "betz/p1/abc.png", width: "small", align: "left" }
      }]
    }
  });

  assert.equal(updated.statusCode, 200);
  const block = updated.json().page.content[0];
  assert.equal(block.image.url, "https://cdn.example.com/step1.png");
  assert.equal(block.image.path, "betz/p1/abc.png");
  assert.equal(block.image.width, "small");
  assert.equal(block.image.align, "left");
  assert.equal(block.text, "Step 1 screenshot");
});

test("the caption is optional and capped at 500 characters", async () => {
  resetStore();
  const cookie = await sessionCookie("betz", "Betz");
  const created = await call(`${API}&action=create`, {
    method: "POST", cookie,
    body: {
      title: "Tutorial",
      content: [
        { id: "a", type: "image", text: "", image: { url: "https://cdn.example.com/a.png" } },
        { id: "b", type: "image", text: "c".repeat(600), image: { url: "https://cdn.example.com/b.png" } }
      ]
    }
  });

  const [noCaption, longCaption] = created.json().page.content;
  assert.equal(noCaption.text, "");
  assert.equal(longCaption.text.length, 500);
});

test("uploading an image requires a session", async () => {
  resetStore();
  const response = await call(`${API}&action=upload-image`, { method: "POST", body: { data: PNG_BASE64 } });
  assert.equal(response.statusCode, 401);
  assert.equal(uploads.length, 0);
});

test("a signed-in member uploads an image and gets a stored url back", async () => {
  resetStore();
  const cookie = await sessionCookie("betz", "Betz");
  const pageId = (await call(`${API}&action=create`, {
    method: "POST", cookie, body: { title: "Tutorial", content: [] }
  })).json().page.id;

  const response = await call(`${API}&action=upload-image&id=${pageId}`, {
    method: "POST", cookie, body: { data: `data:image/png;base64,${PNG_BASE64}` }
  });

  assert.equal(response.statusCode, 201);
  const { image } = response.json();
  assert.equal(image.bucket, "page-images");
  assert.match(image.path, /^betz\/[0-9a-f-]+\/[0-9a-f]{16}\.png$/);
  assert.match(image.url, /\/storage\/v1\/object\/public\/page-images\/betz\//);
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].bytes, PNG_BYTES.length);
  assert.equal(uploads[0].contentType, "image/png");
});

test("only the page creator can attach an image to that page", async () => {
  resetStore();
  const owner = await sessionCookie("betz", "Betz");
  const other = await sessionCookie("omar", "Omar");
  const pageId = (await call(`${API}&action=create`, {
    method: "POST", cookie: owner, body: { title: "Tutorial", content: [] }
  })).json().page.id;

  const denied = await call(`${API}&action=upload-image&id=${pageId}`, {
    method: "POST", cookie: other, body: { data: PNG_BASE64 }
  });
  assert.equal(denied.statusCode, 403);
  assert.equal(uploads.length, 0);

  const allowed = await call(`${API}&action=upload-image&id=${pageId}`, {
    method: "POST", cookie: owner, body: { data: PNG_BASE64 }
  });
  assert.equal(allowed.statusCode, 201);
});

test("uploading a non-image payload is refused", async () => {
  resetStore();
  const cookie = await sessionCookie("betz", "Betz");
  const notAnImage = Buffer.from("#!/bin/sh\necho hello\n").toString("base64");

  const response = await call(`${API}&action=upload-image`, {
    method: "POST", cookie, body: { data: notAnImage }
  });
  assert.equal(response.statusCode, 415);
  assert.equal(uploads.length, 0);
});

test("an oversized image is refused with 413", async () => {
  resetStore();
  const cookie = await sessionCookie("betz", "Betz");
  // A PNG header followed by padding, just over the 3 MB decoded limit.
  const oversized = Buffer.concat([PNG_BYTES, Buffer.alloc(3 * 1024 * 1024)]);

  const response = await call(`${API}&action=upload-image`, {
    method: "POST", cookie, body: { data: oversized.toString("base64") }
  });
  assert.equal(response.statusCode, 413);
  assert.equal(uploads.length, 0);
});

// ------------------------------------------------------------ table block --

test("a table block keeps its grid and header flag", async () => {
  resetStore();
  const cookie = await sessionCookie("betz", "Betz");
  const created = await call(`${API}&action=create`, {
    method: "POST", cookie,
    body: {
      title: "Metrics",
      content: [
        { id: "t1", type: "table", table: { header: true, rows: [["Metric", "Value"], ["Verified wallets", "51"]] } }
      ]
    }
  });

  assert.equal(created.statusCode, 201);
  const [block] = created.json().page.content;
  assert.equal(block.type, "table");
  assert.equal(block.table.header, true);
  assert.deepEqual(block.table.rows, [["Metric", "Value"], ["Verified wallets", "51"]]);
});

test("a table block pads ragged rows into a rectangle", async () => {
  resetStore();
  const cookie = await sessionCookie("betz", "Betz");
  const created = await call(`${API}&action=create`, {
    method: "POST", cookie,
    body: {
      title: "Ragged",
      content: [{ id: "t1", type: "table", table: { rows: [["a"], ["b", "c", "d"], ["e", "f"]] } }]
    }
  });

  const [block] = created.json().page.content;
  // Every row is widened to the widest row so the renderer always sees a grid.
  assert.deepEqual(block.table.rows, [["a", "", ""], ["b", "c", "d"], ["e", "f", ""]]);
  assert.equal(block.table.header, false);
});

test("a table block with no usable rows is dropped", async () => {
  resetStore();
  const cookie = await sessionCookie("betz", "Betz");
  const created = await call(`${API}&action=create`, {
    method: "POST", cookie,
    body: {
      title: "Empty",
      content: [
        { id: "no-rows", type: "table", table: { rows: [] } },
        { id: "bad-shape", type: "table", table: { rows: "nope" } },
        { id: "no-table", type: "table" },
        { id: "zero-col", type: "table", table: { rows: [[], []] } },
        { id: "keep", type: "paragraph", text: "hi" }
      ]
    }
  });

  assert.deepEqual(created.json().page.content.map((b) => b.id), ["keep"]);
});

test("a table block is bounded in rows, columns and cell length", async () => {
  resetStore();
  const cookie = await sessionCookie("betz", "Betz");
  const cell = "x".repeat(2000);
  const rows = Array.from({ length: 500 }, () => Array.from({ length: 50 }, () => cell));

  const created = await call(`${API}&action=create`, {
    method: "POST", cookie,
    body: { title: "Huge", content: [{ id: "t1", type: "table", table: { rows } }] }
  });

  const [block] = created.json().page.content;
  assert.equal(block.table.rows.length, 100);
  assert.equal(block.table.rows[0].length, 20);
  assert.equal(block.table.rows[0][0].length, 500);
});

test("a table block coerces non-string cells and a non-boolean header", async () => {
  resetStore();
  const cookie = await sessionCookie("betz", "Betz");
  const created = await call(`${API}&action=create`, {
    method: "POST", cookie,
    body: {
      title: "Hostile",
      content: [
        { id: "t1", type: "table", table: { header: "yes", rows: [[42, null, ["nested"], { a: 1 }, "ok"]] } }
      ]
    }
  });

  const [block] = created.json().page.content;
  // Only strings survive as cells; a truthy-but-not-true header stays off.
  assert.deepEqual(block.table.rows, [["", "", "", "", "ok"]]);
  assert.equal(block.table.header, false);
});

test("a table block survives a round trip through update", async () => {
  resetStore();
  const cookie = await sessionCookie("betz", "Betz");
  const id = (await call(`${API}&action=create`, {
    method: "POST", cookie,
    body: { title: "Doc", content: [{ id: "p", type: "paragraph", text: "before" }] }
  })).json().page.id;

  const updated = await call(`${API}&action=update&id=${id}`, {
    method: "PATCH", cookie,
    body: {
      content: [{ id: "t1", type: "table", table: { header: true, rows: [["A", "B"], ["1", "2"]] } }]
    }
  });

  const [block] = updated.json().page.content;
  assert.equal(block.type, "table");
  assert.equal(block.table.header, true);
  assert.deepEqual(block.table.rows, [["A", "B"], ["1", "2"]]);
});

test("a table block nested inside a toggle keeps its grid", async () => {
  resetStore();
  const cookie = await sessionCookie("betz", "Betz");
  const created = await call(`${API}&action=create`, {
    method: "POST", cookie,
    body: {
      title: "Nested",
      content: [
        {
          id: "tog", type: "toggle", text: "Section",
          children: [{ id: "t1", type: "table", table: { rows: [["x", "y"]] } }]
        }
      ]
    }
  });

  const [toggle] = created.json().page.content;
  assert.equal(toggle.children[0].type, "table");
  assert.deepEqual(toggle.children[0].table.rows, [["x", "y"]]);
});

// The session cookie is SameSite=None so it survives the Telegram Web/Desktop
// iframe. A None cookie rides along on cross-site requests, so a mutating call
// from another site must be refused on Origin, not merely blocked by CORS.

test("a cross-site mutating request is refused even with a valid cookie", async () => {
  resetStore();
  const cookie = await sessionCookie("betz", "Betz");

  const forged = await call(`${API}&action=create`, {
    method: "POST", cookie,
    headers: { origin: "https://evil.example", host: "dashboard.example" },
    body: { title: "Forged", content: [] }
  });
  assert.equal(forged.statusCode, 403);
  assert.equal(forged.json().ok, false);

  // Nothing was written.
  const list = await call(`${API}&action=list`, { cookie });
  assert.equal(list.json().pages.length, 0);
});

test("a same-origin mutating request is accepted", async () => {
  resetStore();
  const cookie = await sessionCookie("betz", "Betz");
  const created = await call(`${API}&action=create`, {
    method: "POST", cookie,
    headers: { origin: "https://dashboard.example", host: "dashboard.example" },
    body: { title: "Legit", content: [] }
  });
  assert.equal(created.statusCode, 201);
});

test("a mutating request with no Origin is accepted", async () => {
  resetStore();
  const cookie = await sessionCookie("betz", "Betz");
  const created = await call(`${API}&action=create`, {
    method: "POST", cookie, body: { title: "No origin", content: [] }
  });
  assert.equal(created.statusCode, 201);
});

test("the proxy's x-forwarded-host is what Origin is compared against", async () => {
  resetStore();
  const cookie = await sessionCookie("betz", "Betz");
  // On Vercel the internal host differs from the public one; the forwarded host
  // must win, or every real request would look cross-site.
  const created = await call(`${API}&action=create`, {
    method: "POST", cookie,
    headers: { origin: "https://dashboard.example", host: "internal.local", "x-forwarded-host": "dashboard.example" },
    body: { title: "Proxied", content: [] }
  });
  assert.equal(created.statusCode, 201);
});

// ---------------------------------------------------- markdown rendering --

const { renderMarkdown, renderInlineMarkdown } = await import("../public/app/markdown.js");

test("a pipe table becomes a real table with a header row", () => {
  const html = renderMarkdown([
    "| Wallet Metric | Reported Figure |",
    "|---|---:|",
    "| Previously reported verified wallets | 42 |",
    "| Current total verified wallets | **51** |"
  ].join("\n"));

  assert.match(html, /<table class="pg-md-table">/);
  assert.match(html, /<th>Wallet Metric<\/th>/);
  assert.match(html, /<th style="text-align:right">Reported Figure<\/th>/);
  assert.match(html, /<td>Previously reported verified wallets<\/td>/);
  // Bold inside a cell is rendered, not printed as asterisks.
  assert.match(html, /<td style="text-align:right"><strong>51<\/strong><\/td>/);
  assert.doesNotMatch(html, /\*\*51\*\*/);
  assert.doesNotMatch(html, /\|/);
});

test("a row that only has pipes and no separator stays a paragraph", () => {
  const html = renderMarkdown("a | b plain");
  assert.equal(html, "<p>a | b plain</p>");
  assert.equal(renderMarkdown("| just | pipes |"), "<p>| just | pipes |</p>");
});

test("headings, lists and horizontal rules are rendered", () => {
  const html = renderMarkdown([
    "# Title",
    "## Section",
    "",
    "- first",
    "- second",
    "",
    "1. one",
    "2. two",
    "",
    "---"
  ].join("\n"));

  assert.match(html, /<h1 class="pg-md-h">Title<\/h1>/);
  assert.match(html, /<h2 class="pg-md-h">Section<\/h2>/);
  assert.match(html, /<ul><li>first<\/li><li>second<\/li><\/ul>/);
  assert.match(html, /<ol><li>one<\/li><li>two<\/li><\/ol>/);
  assert.match(html, /<hr \/>/);
});

test("bold and italic are rendered", () => {
  assert.equal(renderMarkdown("**51** verified"), "<p><strong>51</strong> verified</p>");
  assert.equal(renderMarkdown("__+9__"), "<p><strong>+9</strong></p>");
  assert.equal(renderMarkdown("a *word* here"), "<p>a <em>word</em> here</p>");
});

test("a bare URL becomes a clickable link and keeps its query string", () => {
  const html = renderMarkdown("Dashboard: https://gimtteam.vercel.app/?member=betz&from=2026-11-01");
  assert.match(html, /<a href="https:\/\/gimtteam\.vercel\.app\/\?member=betz&amp;from=2026-11-01" target="_blank" rel="noopener noreferrer">/);
  assert.match(html, />https:\/\/gimtteam\.vercel\.app\/\?member=betz&amp;from=2026-11-01<\/a>/);
});

test("a trailing period or bracket is not swallowed into the link", () => {
  assert.equal(
    renderMarkdown("See https://kwentofi.live/community/p/272."),
    '<p>See <a href="https://kwentofi.live/community/p/272" target="_blank" rel="noopener noreferrer">https://kwentofi.live/community/p/272</a>.</p>'
  );
  assert.equal(
    renderMarkdown("(https://kwentofi.live/community/p/290)"),
    '<p>(<a href="https://kwentofi.live/community/p/290" target="_blank" rel="noopener noreferrer">https://kwentofi.live/community/p/290</a>)</p>'
  );
});

test("markdown and links are escaped, so a page body cannot inject HTML", () => {
  assert.equal(renderMarkdown("<script>alert(1)</script>"), "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>");
  assert.equal(renderMarkdown("**<b>x</b>**"), "<p><strong>&lt;b&gt;x&lt;/b&gt;</strong></p>");
  assert.equal(renderMarkdown("[x](javascript:alert(1))"), "<p>[x](javascript:alert(1))</p>");
  assert.equal(renderMarkdown("<img src=x onerror=alert(1)>"), "<p>&lt;img src=x onerror=alert(1)&gt;</p>");
});

test("a code span keeps its asterisks literal", () => {
  assert.equal(renderMarkdown("use `**not bold**` here"), "<p>use <code>**not bold**</code> here</p>");
});

test("renderInlineMarkdown formats one line with no paragraph wrapper", () => {
  assert.equal(renderInlineMarkdown("**51** wallets"), "<strong>51</strong> wallets");
  assert.equal(renderInlineMarkdown("plain"), "plain");
});

test("reading pages is not blocked for a cross-site Origin", async () => {
  resetStore();
  const cookie = await sessionCookie("betz", "Betz");
  const list = await call(`${API}&action=list`, {
    cookie, headers: { origin: "https://evil.example", host: "dashboard.example" }
  });
  assert.equal(list.statusCode, 200);
});

// ------------------------------------------------------ shared-page render --

test("a logged-in reader still gets the subpage link on a shared page", async () => {
  // Regression: findPage() preferred the sidebar `pages` list, which omits
  // share_token by design. A reader who happened to be signed in found the
  // subpage there, so the block rendered as a non-clickable span and the
  // subpage could not be opened from the shared page.
  const childId = "6504e0e8-d082-472c-ad25-37e70cb36cf0";
  const token = "16ff51ddf70d6922cc1455e8b5cbb2d1";

  const container = { dataset: {}, innerHTML: "", addEventListener() {} };
  const previousDocument = globalThis.document;
  globalThis.document = {
    querySelector: (selector) => (selector === "#pages-shared" ? container : null)
  };

  try {
    const { state } = await import("../public/app/state.js");
    const { renderSharedPage } = await import("../public/app/pages.js");

    // The signed-in reader's sidebar list is loaded and carries no share_token.
    state.pages.pages = [{ id: childId, parent_id: null, title: "Month of July" }];
    state.pages.memberId = "reader";
    state.pages.shared = {
      page: {
        id: "root",
        title: "Community Moderator",
        created_by_member_name: "Betz",
        content: [{ id: "s", type: "subpage", pageId: childId }]
      },
      breadcrumb: [{ id: "root", title: "Community Moderator" }],
      linkedPages: [{ id: childId, title: "Month of July", share_token: token }]
    };

    renderSharedPage();

    assert.match(container.innerHTML, new RegExp(`<a class="pg-subpage-link" href="\\?page=${token}"`));
    assert.doesNotMatch(container.innerHTML, /pg-subpage-static/);
  } finally {
    globalThis.document = previousDocument;
  }
});
