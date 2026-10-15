import { cp, mkdir, readdir, readFile, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { ITEM_STATUSES, extractFirstUrl, hostnameOf, isValidId, mergeInput, newId, normalizePublishedAt, normalizeTag, normalizeUrl } from "../shared/item.mjs";
import { parseFrontmatter, serializeFrontmatter } from "./frontmatter.mjs";

const INPUT_OPEN = "<!-- memoreader:input -->\n";
const PAGE_OPEN = "<!-- memoreader:page -->\n";
export const MAX_INPUT_CHARS = 200_000;
export const MAX_PAGE_CHARS = 50_000;

function str(value, limit) {
  return typeof value === "string" ? value.slice(0, limit) : "";
}

function oneLine(value, limit) {
  return str(value, limit * 2).replace(/\s+/g, " ").trim().slice(0, limit);
}

function iso(value, fallback) {
  const time = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(time) ? new Date(time).toISOString() : fallback;
}

function httpUrl(value) {
  return typeof value === "string" && /^https?:\/\//i.test(value) ? value.slice(0, 2000) : "";
}

/** A publish date must be a real date and cannot be later than the day the memo was saved. */
function cleanPublishedAt(raw, createdAt) {
  const value = normalizePublishedAt(raw);
  if (!value) return "";
  return Date.parse(value) > Date.parse(createdAt) + 86_400_000 ? "" : value;
}

/** Validates and bounds an item's metadata. Returns null when the id is unusable. */
export function cleanMeta(raw, nowIso = new Date().toISOString()) {
  if (!raw || !isValidId(raw.id)) return null;
  const createdAt = iso(raw.createdAt, nowIso);
  const tags = [];
  for (const entry of Array.isArray(raw.tags) ? raw.tags : []) {
    // Obsidian-safe: no spaces or punctuation, so the same tags work inside a vault.
    const tag = normalizeTag(entry);
    if (tag && !tags.some((existing) => existing.toLowerCase() === tag.toLowerCase())) tags.push(tag);
    if (tags.length >= 20) break;
  }
  return {
    id: raw.id,
    status: ITEM_STATUSES.includes(raw.status) ? raw.status : "pending",
    source: oneLine(raw.source, 20) || "web",
    sourceRef: oneLine(raw.sourceRef, 100),
    url: normalizeUrl(raw.url).slice(0, 2000),
    title: oneLine(raw.title, 200),
    summary: str(raw.summary, 3000),
    category: oneLine(raw.category, 40),
    tags,
    favorite: raw.favorite === true,
    createdAt,
    updatedAt: iso(raw.updatedAt, createdAt),
    publishedAt: cleanPublishedAt(raw.publishedAt, createdAt),
    error: oneLine(raw.error, 500),
    siteName: oneLine(raw.siteName, 100),
    image: httpUrl(raw.image),
    video: httpUrl(raw.video),
    images: (Array.isArray(raw.images) ? raw.images : []).map(httpUrl).filter(Boolean).slice(0, 8),
  };
}

const RESERVED_NAMES = /^(con|prn|aux|nul|com\d|lpt\d)$/i;
export const INBOX_FOLDER = "_inbox";

function folderSegment(raw) {
  // Characters Windows forbids in file names, plus control characters.
  const cleaned = String(raw)
    .replace(/[<>:"\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+|[. ]+$/g, "")
    .slice(0, 40);
  if (!cleaned) return "";
  return RESERVED_NAMES.test(cleaned) ? `${cleaned}_` : cleaned;
}

/**
 * Folder path (relative to the items root) an item is filed under. "/" in a category makes
 * sub-folders ("네트워크/DNS"), at most three levels. Items without a category wait in the inbox.
 */
export function categoryFolder(category) {
  const segments = String(category ?? "")
    .split("/")
    .map(folderSegment)
    .filter(Boolean)
    .slice(0, 3);
  return segments.length ? segments : [INBOX_FOLDER];
}

// Obsidian cannot link to notes whose names contain # ^ [ ] |, and Windows forbids several more.
const FORBIDDEN_IN_NOTE_NAME = /[<>:"\\|?*#^[\]/\u0000-\u001f]/g;

function noteNameSegment(raw, limit = 60) {
  const cleaned = String(raw)
    .replace(FORBIDDEN_IN_NOTE_NAME, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+|[. ]+$/g, "")
    .slice(0, limit)
    .trim();
  return RESERVED_NAMES.test(cleaned) ? `${cleaned}_` : cleaned;
}

/** "<title> (<random id part>).md": readable in Obsidian, and unique even when two titles match. */
export function noteFileName(meta, input) {
  const base = noteNameSegment(meta.title || String(input).replace(/\s+/g, " ").trim()) || "제목 없음";
  return `${base} (${meta.id.slice(-6)}).md`;
}

const CASE_INSENSITIVE_FS = process.platform === "win32" || process.platform === "darwin";

function samePath(a, b) {
  return CASE_INSENSITIVE_FS ? a.toLowerCase() === b.toLowerCase() : a === b;
}

// Parentheses and spaces would end a Markdown link early, so they are percent-encoded.
const markdownUrl = (url) => url.replace(/\(/g, "%28").replace(/\)/g, "%29").replace(/\s/g, "%20");

function buildFile(meta, input, page) {
  let head = `# ${meta.title || "제목 없음"}\n\n`;
  if (meta.url) head += `[${hostnameOf(meta.url) || meta.url}](${markdownUrl(meta.url)})\n\n`;
  // A remote picture embed renders as a preview in Obsidian's reading view.
  if (meta.image) head += `![](${markdownUrl(meta.image)})\n\n`;
  let body = `${head}## 요약\n\n${meta.summary || "_정리 전_"}\n\n## 원문\n\n`;
  body += INPUT_OPEN;
  const inputStart = body.length;
  body += `${input}\n\n`;
  let pageStart = 0;
  if (page) {
    body += `## 링크 본문\n\n${PAGE_OPEN}`;
    pageStart = body.length;
    body += `${page}\n`;
  }
  return serializeFrontmatter(
    { ...meta, inputStart, inputLength: input.length, pageStart, pageLength: page.length },
    body,
  );
}

function sliceSection(body, start, length, open) {
  if (Number.isInteger(start) && Number.isInteger(length) && start >= open.length && body.startsWith(open, start - open.length)) {
    return body.slice(start, start + length);
  }
  // The file was edited by hand and the recorded offsets no longer line up.
  const at = body.indexOf(open);
  if (at < 0) return "";
  const rest = body.slice(at + open.length);
  const end = rest.indexOf("\n\n## ");
  return (end < 0 ? rest : rest.slice(0, end)).replace(/\n+$/, "");
}

function parseFile(text) {
  const { meta, body } = parseFrontmatter(text);
  return {
    meta: cleanMeta(meta),
    rawTags: Array.isArray(meta.tags) ? meta.tags : [],
    input: sliceSection(body, meta.inputStart, meta.inputLength, INPUT_OPEN),
    page: sliceSection(body, meta.pageStart, meta.pageLength, PAGE_OPEN),
  };
}

function searchTextOf(meta, input) {
  return [meta.title, meta.summary, meta.category, meta.tags.join(" "), meta.url, input.slice(0, 2000)]
    .join("\n")
    .toLowerCase();
}

function previewOf(input) {
  return input.replace(/\s+/g, " ").trim().slice(0, 160);
}

async function atomicWrite(file, text) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, text, "utf8");
  await rename(temp, file);
}

/**
 * Items are Markdown notes under `vaultDir` ("vault_output" inside the data folder by default),
 * filed by category. Open that folder as an Obsidian vault, or point `vaultDir` at a folder inside
 * an existing vault. Sync bookkeeping (tombstones) stays in `dataDir`, outside the vault.
 */
export async function createStore(dataDir, { vaultDir } = {}) {
  const itemsRoot = vaultDir ? path.resolve(vaultDir) : path.join(dataDir, "vault_output");
  const legacyRoot = path.join(dataDir, "items");
  const tombstoneFile = path.join(dataDir, "tombstones.json");
  const entries = new Map();
  let tombstones = {};
  let chain = Promise.resolve();

  // Every mutation runs one at a time so two writers can never interleave on the same file.
  function locked(task) {
    const run = chain.then(task);
    chain = run.catch(() => {});
    return run;
  }

  function stampAfter(previous) {
    const now = new Date().toISOString();
    if (!previous || now > previous) return now;
    return new Date(Date.parse(previous) + 1).toISOString();
  }

  function fileFor(meta, input) {
    return path.join(itemsRoot, ...categoryFolder(meta.category), noteFileName(meta, input));
  }

  // Removes a folder left empty by a move, and its parents up to (not including) the items root.
  async function pruneEmptyFolders(start) {
    let folder = start;
    while (folder.length > itemsRoot.length && folder.startsWith(itemsRoot)) {
      try {
        await rmdir(folder);
      } catch {
        return;
      }
      folder = path.dirname(folder);
    }
  }

  /** Writes the item into its category folder and moves it there if the category changed. */
  // Listeners hear about every stored change (item written or deleted), e.g. to wake open clients.
  const changeListeners = new Set();
  function notifyChange() {
    for (const listener of changeListeners) {
      try {
        listener();
      } catch {
        // A broken listener must not break storage.
      }
    }
  }

  async function writeEntry(meta, input, page) {
    const file = fileFor(meta, input);
    const previous = entries.get(meta.id)?.file;
    await atomicWrite(file, buildFile(meta, input, page));
    if (previous && !samePath(previous, file)) {
      await rm(previous, { force: true });
      await pruneEmptyFolders(path.dirname(previous));
    }
    entries.set(meta.id, { meta, file, searchText: searchTextOf(meta, input), preview: previewOf(input) });
    notifyChange();
  }

  async function saveTombstones() {
    await atomicWrite(tombstoneFile, JSON.stringify(tombstones));
    notifyChange();
  }

  // Earlier versions kept notes in <data>/items. Move them into the vault folder once.
  async function migrateLegacyFolder() {
    const files = await listMarkdownFiles(legacyRoot);
    for (const file of files) {
      const target = path.join(itemsRoot, path.relative(legacyRoot, file));
      await mkdir(path.dirname(target), { recursive: true });
      try {
        await rename(file, target);
      } catch {
        // Different drives cannot be renamed across; copy then remove instead.
        await cp(file, target);
        await rm(file, { force: true });
      }
    }
    if (files.length) await pruneLegacyFolders(legacyRoot);
  }

  async function pruneLegacyFolders(folder) {
    for (const child of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
      if (child.isDirectory()) await pruneLegacyFolders(path.join(folder, child.name));
    }
    await rmdir(folder).catch(() => {});
  }

  async function load() {
    try {
      tombstones = JSON.parse(await readFile(tombstoneFile, "utf8"));
    } catch {
      tombstones = {};
    }
    if (!samePath(legacyRoot, itemsRoot)) await migrateLegacyFolder();

    // Files that should be rewritten once: wrong name/folder for their content, or tags that were
    // saved before tags had to be Obsidian-safe.
    const rewrites = [];
    for (const file of await listMarkdownFiles(itemsRoot)) {
      try {
        const { meta, input, page, rawTags } = parseFile(await readFile(file, "utf8"));
        // Any other note in the vault (the user's own) has no valid id and is left alone.
        if (!meta) continue;
        const existing = entries.get(meta.id);
        // A crash between writing the new copy and deleting the old one leaves two files; keep the newer.
        if (existing && existing.meta.updatedAt >= meta.updatedAt) {
          if (!samePath(existing.file, file)) await rm(file, { force: true });
          continue;
        }
        if (existing && !samePath(existing.file, file)) await rm(existing.file, { force: true });
        entries.set(meta.id, { meta, file, searchText: searchTextOf(meta, input), preview: previewOf(input) });
        const tagsChanged = JSON.stringify(rawTags) !== JSON.stringify(meta.tags);
        if (tagsChanged || !samePath(file, fileFor(meta, input))) rewrites.push({ meta, input, page, tagsChanged });
      } catch {
        // An unreadable file is skipped rather than blocking startup.
      }
    }
    for (const { meta, input, page, tagsChanged } of rewrites) {
      // Changed tags are real edits, so devices must hear about them.
      const next = tagsChanged ? { ...meta, updatedAt: stampAfter(meta.updatedAt) } : meta;
      await writeEntry(next, input, page);
    }
  }

  // Dot folders (.obsidian, .trash) belong to Obsidian, not to us.
  async function listMarkdownFiles(folder) {
    const found = [];
    let children = [];
    try {
      children = await readdir(folder, { withFileTypes: true });
    } catch {
      return found;
    }
    for (const child of children) {
      if (child.name.startsWith(".")) continue;
      const full = path.join(folder, child.name);
      if (child.isDirectory()) found.push(...(await listMarkdownFiles(full)));
      else if (child.name.endsWith(".md")) found.push(full);
    }
    return found;
  }

  await load();

  function publicMeta(entry) {
    return { ...entry.meta, tags: [...entry.meta.tags], preview: entry.preview };
  }

  async function readContent(id) {
    const entry = entries.get(id);
    if (!entry) return null;
    const { input, page } = parseFile(await readFile(entry.file, "utf8"));
    return { input, page };
  }

  function findDuplicate({ url, sourceRef, exceptId = "" }) {
    for (const entry of entries.values()) {
      if (entry.meta.id === exceptId) continue;
      if (sourceRef && entry.meta.sourceRef === sourceRef) return entry;
      if (url && entry.meta.url === url) return entry;
    }
    return null;
  }

  /**
   * Folds a second save of the same link into the item that is already here. Nothing is lost: the
   * texts are combined, tags are united, favorites and the earlier save time are kept.
   */
  async function foldInto(entry, incoming) {
    const current = await readContent(entry.meta.id);
    const input = mergeInput(current.input, incoming.input ?? "");
    const tags = [...entry.meta.tags, ...(incoming.tags ?? [])];
    const latest = [entry.meta.updatedAt, incoming.updatedAt ?? ""].sort().at(-1);
    const meta = cleanMeta({
      ...entry.meta,
      tags,
      favorite: entry.meta.favorite || incoming.favorite === true,
      createdAt: [entry.meta.createdAt, incoming.createdAt ?? entry.meta.createdAt].sort()[0],
      updatedAt: stampAfter(latest),
    });
    await writeEntry(meta, input, current.page);
    return meta;
  }

  return {
    /** Absolute path of the folder that holds the notes (the Obsidian vault folder). */
    vaultPath: itemsRoot,

    get(id) {
      const entry = entries.get(id);
      return entry ? publicMeta(entry) : null;
    },

    readContent,

    /** Registers a callback for every stored change. Returns a function that removes it. */
    onChange(listener) {
      changeListeners.add(listener);
      return () => changeListeners.delete(listener);
    },

    /** Creates an item from raw text. Returns the existing item when the same link/message was saved. */
    create({ input, url = "", source = "web", sourceRef = "", title = "", createdAt = "", publishedAt = "" }) {
      return locked(async () => {
        const text = str(input, MAX_INPUT_CHARS);
        const link = normalizeUrl(url) || extractFirstUrl(text);
        const duplicate = findDuplicate({ url: link, sourceRef });
        if (duplicate) {
          // The same message delivered twice changes nothing; the same link with other words adds them.
          if (sourceRef && duplicate.meta.sourceRef === sourceRef) return { item: publicMeta(duplicate), duplicate: true };
          const before = (await readContent(duplicate.meta.id)).input;
          await foldInto(duplicate, { input: text });
          const merged = (await readContent(duplicate.meta.id)).input !== before;
          return { item: publicMeta(entries.get(duplicate.meta.id)), duplicate: true, merged };
        }
        const now = new Date().toISOString();
        // A message that waited in a queue (Telegram) keeps the time it was actually sent.
        const created = iso(createdAt, now) > now ? now : iso(createdAt, now);
        const meta = cleanMeta({ id: newId(), source, sourceRef, url: link, title, status: "pending", createdAt: created, updatedAt: now, publishedAt }, now);
        await writeEntry(meta, text, "");
        return { item: publicMeta(entries.get(meta.id)), duplicate: false };
      });
    },

    /** Applies a metadata patch (and optionally new page text); bumps updatedAt so devices re-sync it. */
    update(id, patch = {}, content = {}) {
      return locked(async () => {
        const entry = entries.get(id);
        if (!entry) return null;
        const current = await readContent(id);
        const input = typeof content.input === "string" ? str(content.input, MAX_INPUT_CHARS) : current.input;
        const page = typeof content.page === "string" ? str(content.page, MAX_PAGE_CHARS) : current.page;
        const meta = cleanMeta({ ...entry.meta, ...patch, id, createdAt: entry.meta.createdAt, updatedAt: stampAfter(entry.meta.updatedAt) });
        await writeEntry(meta, input, page);
        return publicMeta(entries.get(id));
      });
    },

    /** Last-writer-wins merge of an item pushed by a device. Returns whether it was applied. */
    upsertFromSync(raw) {
      return locked(async () => {
        const meta = cleanMeta(raw);
        if (!meta) return false;
        const input = str(raw.input, MAX_INPUT_CHARS);
        // A device may send only the text; the link inside it still has to drive page fetching.
        // Imported files are the exception: a long article that mentions an address is not a link to that address.
        if (!meta.url && meta.source !== "file") meta.url = extractFirstUrl(input);
        const existing = entries.get(meta.id);
        // Devices that predate the field send none; do not erase a date the server already found.
        if (!meta.publishedAt && existing?.meta.publishedAt) meta.publishedAt = existing.meta.publishedAt;
        if (existing && existing.meta.updatedAt >= meta.updatedAt) return false;
        const deletedAt = tombstones[meta.id];
        if (deletedAt && deletedAt >= meta.updatedAt) return false;

        // The same link saved on two devices (or by Telegram and a phone) becomes one item. The
        // incoming copy is folded into the one already here and its id is retired so every device
        // drops its duplicate on the next sync.
        const duplicate = meta.url && !existing ? findDuplicate({ url: meta.url, exceptId: meta.id }) : null;
        if (duplicate) {
          await foldInto(duplicate, { input, tags: meta.tags, favorite: meta.favorite, createdAt: meta.createdAt, updatedAt: meta.updatedAt });
          tombstones[meta.id] = stampAfter(meta.updatedAt);
          await saveTombstones();
          return true;
        }
        await writeEntry(meta, input, str(raw.page, MAX_PAGE_CHARS));
        if (deletedAt) {
          delete tombstones[meta.id];
          await saveTombstones();
        }
        return true;
      });
    },

    /** Deletes an item (or records a deletion made on another device) and remembers it for sync. */
    remove(id, deletedAtRaw) {
      return locked(async () => {
        const entry = entries.get(id);
        const deletedAt = iso(deletedAtRaw, new Date().toISOString());
        if (entry && entry.meta.updatedAt > deletedAt) return false;
        if (entry) {
          await rm(entry.file, { force: true });
          await pruneEmptyFolders(path.dirname(entry.file));
          entries.delete(id);
        }
        if (!tombstones[id] || tombstones[id] < deletedAt) {
          tombstones[id] = deletedAt;
          await saveTombstones();
        }
        return Boolean(entry);
      });
    },

    list({ q = "", category = "", tag = "", status = "", favorite = false, limit = 60, offset = 0 } = {}) {
      const terms = String(q).toLowerCase().split(/\s+/).filter(Boolean);
      const matches = [...entries.values()]
        .filter((entry) => {
          const meta = entry.meta;
          if (category && meta.category !== category) return false;
          if (tag && !meta.tags.includes(tag)) return false;
          if (status && meta.status !== status) return false;
          if (favorite && !meta.favorite) return false;
          return terms.every((term) => entry.searchText.includes(term));
        })
        .sort((a, b) => (a.meta.createdAt < b.meta.createdAt ? 1 : -1));
      return { total: matches.length, items: matches.slice(offset, offset + limit).map(publicMeta) };
    },

    stats() {
      const categories = new Map();
      const tags = new Map();
      for (const { meta } of entries.values()) {
        if (meta.category) categories.set(meta.category, (categories.get(meta.category) ?? 0) + 1);
        for (const tag of meta.tags) tags.set(tag, (tags.get(tag) ?? 0) + 1);
      }
      const rank = (map) => [...map].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
      return { total: entries.size, categories: rank(categories), tags: rank(tags).slice(0, 80) };
    },

    /** Items waiting for (or interrupted during) organizing. */
    pendingIds() {
      return [...entries.values()]
        .filter((entry) => entry.meta.status === "pending" || entry.meta.status === "processing")
        .sort((a, b) => (a.meta.createdAt < b.meta.createdAt ? -1 : 1))
        .map((entry) => entry.meta.id);
    },

    /**
     * One page of changes after a cursor ("" for everything). Items and deletions share one ordered
     * stream so a single cursor covers both.
     */
    async changesSince(cursor = "", limit = 100) {
      const events = [];
      for (const { meta } of entries.values()) {
        const key = `${meta.updatedAt}|${meta.id}`;
        if (key > cursor) events.push({ key, id: meta.id, type: "item" });
      }
      for (const [id, deletedAt] of Object.entries(tombstones)) {
        const key = `${deletedAt}|${id}`;
        if (key > cursor) events.push({ key, id, type: "deleted", deletedAt });
      }
      events.sort((a, b) => (a.key < b.key ? -1 : 1));
      const page = events.slice(0, limit);
      const items = [];
      const deleted = [];
      for (const event of page) {
        if (event.type === "deleted") {
          deleted.push({ id: event.id, deletedAt: event.deletedAt });
          continue;
        }
        const entry = entries.get(event.id);
        const content = entry ? await readContent(event.id) : null;
        if (entry && content) items.push({ ...entry.meta, tags: [...entry.meta.tags], ...content });
      }
      return {
        items,
        deleted,
        cursor: page.length ? page[page.length - 1].key : cursor,
        hasMore: events.length > page.length,
      };
    },
  };
}
