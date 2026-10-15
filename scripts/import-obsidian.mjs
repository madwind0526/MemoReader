// Imports notes from an existing Obsidian vault into MemoReader. The vault is only read, never changed.
// Each note becomes a pending memo (its text is the original, its `source` link is the url, `created` /
// `published` dates are kept); the server then organizes it like any other memo and picks the category.
// Dry run by default. Pass --apply to import; the current vault is copied to a backup first.
//   node scripts/import-obsidian.mjs <vault> --folders Clippings,prompt,2027-07,workflow [--apply] [--base http://127.0.0.1:4313]
import { existsSync } from "node:fs";
import { cp, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { newId, normalizePublishedAt, normalizeUrl } from "../shared/item.mjs";

const args = process.argv.slice(2);
const flag = (name, fallback = "") => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const vault = args.find((arg) => !arg.startsWith("--") && args[args.indexOf(arg) - 1] !== "--folders" && args[args.indexOf(arg) - 1] !== "--base");
const folders = flag("--folders").split(",").filter(Boolean);
const apply = args.includes("--apply");
const base = flag("--base", "http://127.0.0.1:4313");
if (!vault || !folders.length) {
  console.error("usage: node scripts/import-obsidian.mjs <vault> --folders A,B [--apply]");
  process.exit(1);
}

async function* markdownFiles(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* markdownFiles(full);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) yield full;
  }
}

/** Minimal frontmatter reader: top-level `key: value` pairs only (that is all that is needed here). */
function split(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { meta: {}, body: text };
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([A-Za-z_]+):\s*(.*)$/.exec(line);
    if (pair) meta[pair[1]] = pair[2].replace(/^"(.*)"$/, "$1").replace(/\\"/g, '"').trim();
  }
  return { meta, body: text.slice(match[0].length) };
}

const pulled = await (await fetch(`${base}/api/sync/pull?limit=200`)).json();
if (pulled.items.length >= 200) console.warn("warning: only the first 200 existing memos were read for duplicate detection");
const known = new Set(pulled.items.map((item) => item.sourceRef).filter(Boolean));
const knownUrls = new Set(pulled.items.map((item) => item.url).filter(Boolean));

const items = [];
const skipped = { empty: 0, already: 0, sameLink: 0 };
const now = Date.now();
for (const folder of folders) {
  const root = path.join(vault, folder);
  if (!existsSync(root)) {
    console.warn(`missing folder: ${root}`);
    continue;
  }
  for await (const file of markdownFiles(root)) {
    const relative = path.relative(vault, file).replaceAll("\\", "/");
    const sourceRef = `obsidian:${relative}`.slice(0, 100);
    if (known.has(sourceRef)) {
      skipped.already += 1;
      continue;
    }
    const raw = await readFile(file, "utf8");
    const { meta, body } = split(raw);
    const url = /^https?:\/\//i.test(meta.source ?? "") ? meta.source : "";
    const text = body.trim() || url;
    if (!text) {
      skipped.empty += 1;
      continue;
    }
    if (url && knownUrls.has(normalizeUrl(url))) skipped.sameLink += 1; // still imported: the server merges the text into the existing memo
    const created = /^\d{4}-\d{2}-\d{2}/.test(meta.created ?? "") ? new Date(`${meta.created.slice(0, 10)}T00:00:00`) : (await stat(file)).mtime;
    const createdAt = new Date(Math.min(created.getTime(), now)).toISOString();
    items.push({
      id: newId(),
      status: "pending",
      source: "obsidian",
      sourceRef,
      url,
      title: meta.title || path.basename(file, ".md"),
      publishedAt: normalizePublishedAt(meta.published ?? ""),
      createdAt,
      updatedAt: new Date(now + items.length).toISOString(),
      input: text,
    });
  }
}

const byFolder = new Map();
for (const item of items) {
  const top = item.sourceRef.split("/")[0].replace("obsidian:", "");
  byFolder.set(top, (byFolder.get(top) ?? 0) + 1);
}
console.log(`notes to import: ${items.length}  (${[...byFolder].map(([name, count]) => `${name} ${count}`).join(", ")})`);
console.log(`skipped: already imported ${skipped.already}, empty ${skipped.empty}; same link as an existing memo (will merge): ${skipped.sameLink}`);
console.log(`with link: ${items.filter((item) => item.url).length}, with original date: ${items.filter((item) => item.publishedAt).length}`);

if (!apply) {
  console.log("dry run only. Run again with --apply to import.");
} else if (items.length) {
  const settings = await (await fetch(`${base}/api/settings`)).json();
  const current = settings.storage?.vaultDir;
  if (current) {
    const backup = path.join(path.dirname(current), `${path.basename(current)}-backup-before-obsidian-import`);
    if (existsSync(backup)) console.log(`backup already exists: ${backup}`);
    else {
      await cp(current, backup, { recursive: true });
      console.log(`backup: ${backup}`);
    }
  }
  // Pushed in small batches so a request never gets very large.
  let applied = 0;
  for (let index = 0; index < items.length; index += 20) {
    const response = await fetch(`${base}/api/sync/push`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items: items.slice(index, index + 20), deleted: [] }) });
    applied += (await response.json()).applied ?? 0;
  }
  console.log(`pushed: ${applied} of ${items.length}`);
}
