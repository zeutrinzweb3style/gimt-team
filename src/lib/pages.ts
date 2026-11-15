import { eq, order, params, type ImageAlign, type ImageWidth, type Page, type PageBlock, type PageImage, type PageTable, type SupabaseRestClient } from "./supabase.js";

// Hierarchical pages (Notion-style). A page is a row in `public.pages`; nesting
// is a self-reference through `parent_id`. Every page carries an unguessable
// `share_token` so a single page can be shared by link, and the token never
// changes once issued.

/** A share token is 32 hex characters (16 random bytes). */
export function createShareToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function isValidShareToken(token: string | undefined | null): boolean {
  return typeof token === "string" && /^[0-9a-f]{32}$/.test(token);
}

/**
 * Blocks arrive from the browser as JSON, so normalise the tree before it is
 * stored: keep only known fields, drop empty blocks, and bound the depth so a
 * crafted payload cannot produce an unbounded tree.
 */
const MAX_BLOCK_DEPTH = 6;
const MAX_BLOCKS_PER_LEVEL = 500;
const MAX_TEXT_LENGTH = 20000;
const MAX_CAPTION_LENGTH = 500;
/** A table is bounded on both axes so a crafted grid cannot exhaust memory. */
const MAX_TABLE_ROWS = 100;
const MAX_TABLE_COLUMNS = 20;
const MAX_CELL_LENGTH = 500;

const IMAGE_WIDTHS: readonly string[] = ["small", "medium", "large", "full"];
const IMAGE_ALIGNS: readonly string[] = ["left", "center", "right"];

/**
 * Normalise the `image` payload of an image block. The URL must be a plain
 * http(s) address, so a crafted page cannot smuggle a `javascript:` or `data:`
 * payload into every reader's browser. Returns null when the block is unusable.
 */
function sanitizeImage(input: unknown): PageImage | null {
  if (!input || typeof input !== "object") return null;
  const candidate = input as Record<string, unknown>;

  const url = typeof candidate.url === "string" ? candidate.url.trim() : "";
  if (!url || !isAllowedImageUrl(url)) return null;

  const width = IMAGE_WIDTHS.includes(String(candidate.width)) ? (candidate.width as ImageWidth) : "medium";
  const align = IMAGE_ALIGNS.includes(String(candidate.align)) ? (candidate.align as ImageAlign) : "center";
  const alt = typeof candidate.alt === "string" ? candidate.alt.slice(0, MAX_CAPTION_LENGTH) : undefined;

  const image: PageImage = {
    url: url.slice(0, 2000),
    bucket: typeof candidate.bucket === "string" ? candidate.bucket.slice(0, 100) : "",
    path: typeof candidate.path === "string" ? candidate.path.slice(0, 500) : "",
    width,
    align
  };
  if (alt) image.alt = alt;
  return image;
}

/** Absolute http(s) URL, or a same-origin path starting with `/`. */
function isAllowedImageUrl(url: string): boolean {
  try {
    const parsed = new URL(url, "https://local.invalid");
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Normalise the `table` payload of a table block. Cells are coerced to strings
 * (a non-string cell becomes empty), the grid is clamped to the row and column
 * ceilings, and every row is padded to the widest one so the stored grid is
 * always rectangular. Returns null when no usable grid remains.
 */
function sanitizeTable(input: unknown): PageTable | null {
  if (!input || typeof input !== "object") return null;
  const rows = (input as Record<string, unknown>).rows;
  if (!Array.isArray(rows) || rows.length === 0) return null;

  const grid: string[][] = [];
  let width = 0;
  for (const row of rows.slice(0, MAX_TABLE_ROWS)) {
    if (!Array.isArray(row)) continue;
    const cells = row.slice(0, MAX_TABLE_COLUMNS).map((cell) =>
      typeof cell === "string" ? cell.slice(0, MAX_CELL_LENGTH) : ""
    );
    if (cells.length === 0) continue;
    width = Math.max(width, cells.length);
    grid.push(cells);
  }
  if (grid.length === 0 || width === 0) return null;

  for (const row of grid) {
    while (row.length < width) row.push("");
  }

  return { rows: grid, header: (input as Record<string, unknown>).header === true };
}

export function sanitizeBlocks(input: unknown, depth = 0): PageBlock[] {
  if (depth > MAX_BLOCK_DEPTH || !Array.isArray(input)) return [];

  const blocks: PageBlock[] = [];
  for (const raw of input.slice(0, MAX_BLOCKS_PER_LEVEL)) {
    if (!raw || typeof raw !== "object") continue;
    const candidate = raw as Record<string, unknown>;
    const type = candidate.type;
    if (type !== "paragraph" && type !== "heading" && type !== "toggle" && type !== "subpage" && type !== "image" && type !== "table") continue;

    const text = typeof candidate.text === "string" ? candidate.text.slice(0, MAX_TEXT_LENGTH) : "";
    const level = candidate.level === 1 || candidate.level === 2 || candidate.level === 3 ? candidate.level : undefined;

    if (type === "image") {
      const image = sanitizeImage(candidate.image);
      if (!image) continue;
      const block: PageBlock = {
        id: typeof candidate.id === "string" && candidate.id ? candidate.id.slice(0, 64) : crypto.randomUUID(),
        type,
        text: text.slice(0, MAX_CAPTION_LENGTH),
        image
      };
      blocks.push(block);
      continue;
    }

    if (type === "table") {
      const table = sanitizeTable(candidate.table);
      if (!table) continue;
      blocks.push({
        id: typeof candidate.id === "string" && candidate.id ? candidate.id.slice(0, 64) : crypto.randomUUID(),
        type,
        text: "",
        table
      });
      continue;
    }

    const block: PageBlock = {
      id: typeof candidate.id === "string" && candidate.id ? candidate.id.slice(0, 64) : crypto.randomUUID(),
      type,
      text
    };
    if (level !== undefined) block.level = level;
    if (type === "toggle") block.collapsed = candidate.collapsed === true;
    if (type === "subpage" && typeof candidate.pageId === "string") block.pageId = candidate.pageId.slice(0, 64);

    const children = sanitizeBlocks(candidate.children, depth + 1);
    if (children.length > 0) block.children = children;

    // A heading/toggle with no text and no children is an empty stub; a paragraph
    // with no text is also empty. Neither is worth persisting.
    if (type !== "subpage" && !block.text.trim() && !block.children?.length) continue;
    blocks.push(block);
  }
  return blocks;
}

export function sanitizeTitle(input: unknown): string {
  const title = typeof input === "string" ? input.trim() : "";
  return title.slice(0, 300) || "Untitled";
}

/** Every page, newest first. The dashboard builds the tree client-side. */
export async function listPages(db: SupabaseRestClient): Promise<Page[]> {
  return db.select<Page>("pages", params(order("created_at", true)));
}

export async function getPageById(db: SupabaseRestClient, id: string): Promise<Page | null> {
  const rows = await db.select<Page>("pages", params(eq("id", id)));
  return rows[0] ?? null;
}

export async function getPageByShareToken(db: SupabaseRestClient, token: string): Promise<Page | null> {
  const rows = await db.select<Page>("pages", params(eq("share_token", token)));
  return rows[0] ?? null;
}

export type CreatePageInput = {
  parentId: string | null;
  title: string;
  content: PageBlock[];
  memberId: string;
  memberName: string;
};

export async function createPage(db: SupabaseRestClient, input: CreatePageInput): Promise<Page> {
  const rows = await db.insert<Page>("pages", {
    parent_id: input.parentId,
    title: sanitizeTitle(input.title),
    content: input.content,
    share_token: createShareToken(),
    created_by_member_id: input.memberId,
    created_by_member_name: input.memberName
  });
  if (!rows[0]) throw new Error("Page insert returned no row");
  return rows[0];
}

export type UpdatePageInput = {
  title?: string;
  content?: PageBlock[];
  parentId?: string | null;
  memberId: string;
};

export async function updatePage(db: SupabaseRestClient, id: string, input: UpdatePageInput): Promise<Page | null> {
  const payload: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
    updated_by_member_id: input.memberId
  };
  if (input.title !== undefined) payload.title = sanitizeTitle(input.title);
  if (input.content !== undefined) payload.content = input.content;
  if (input.parentId !== undefined) payload.parent_id = input.parentId;

  const rows = await db.update<Page>("pages", payload, params(eq("id", id)));
  return rows[0] ?? null;
}

export async function deletePage(db: SupabaseRestClient, id: string): Promise<void> {
  await db.delete("pages", params(eq("id", id)));
}

/**
 * True when moving `pageId` under `parentId` would create a cycle, i.e. the new
 * parent is the page itself or one of its descendants. Walk up from the target
 * parent; if we reach the page, the move is illegal.
 */
export async function wouldCreateCycle(
  db: SupabaseRestClient,
  pageId: string,
  parentId: string
): Promise<boolean> {
  if (pageId === parentId) return true;

  const pages = await listPages(db);
  const parentOf = new Map(pages.map((page) => [page.id, page.parent_id]));

  let cursor: string | null = parentId;
  const seen = new Set<string>();
  while (cursor) {
    if (cursor === pageId) return true;
    if (seen.has(cursor)) return true; // pre-existing cycle; refuse rather than loop
    seen.add(cursor);
    cursor = parentOf.get(cursor) ?? null;
  }
  return false;
}

export type PageTreeNode = Page & { children: PageTreeNode[] };

/** Build the parent/child tree from a flat list, preserving input order. */
export function buildPageTree(pages: Page[]): PageTreeNode[] {
  const nodes = new Map<string, PageTreeNode>();
  for (const page of pages) nodes.set(page.id, { ...page, children: [] });

  const roots: PageTreeNode[] = [];
  for (const page of pages) {
    const node = nodes.get(page.id)!;
    const parent = page.parent_id ? nodes.get(page.parent_id) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

/**
 * The page plus every descendant, used when deleting so a client knows how many
 * subpages go with it. The DB cascades on delete, so this is informational.
 */
export function collectDescendantIds(pages: Page[], rootId: string): string[] {
  const childrenOf = new Map<string, string[]>();
  for (const page of pages) {
    if (!page.parent_id) continue;
    const list = childrenOf.get(page.parent_id) ?? [];
    list.push(page.id);
    childrenOf.set(page.parent_id, list);
  }

  const ids: string[] = [];
  const queue = [rootId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    ids.push(id);
    queue.push(...(childrenOf.get(id) ?? []));
  }
  return ids;
}
