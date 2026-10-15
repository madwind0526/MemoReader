// Fills in the original publish date of memos saved before the field existed. No LLM is used:
//   1. exact time from the address (Instagram / Threads / X)
//   2. date stated by the page itself (meta, JSON-LD, <time>, Instagram description)
// Dry run by default. Pass --apply to write; the vault folder is copied to a backup first.
//   node scripts/backfill-published.mjs [--apply] [--base http://127.0.0.1:4313]
import { existsSync } from "node:fs";
import { cp } from "node:fs/promises";
import path from "node:path";

import { fetchPage } from "../backend/fetch-page.mjs";
import { publishedFromUrl } from "../shared/item.mjs";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const base = args.includes("--base") ? args[args.indexOf("--base") + 1] : "http://127.0.0.1:4313";

const pulled = await (await fetch(`${base}/api/sync/pull?limit=200`)).json();
if (pulled.items.length >= 200) console.warn("only the first 200 memos were read; run again after applying to continue");
const candidates = pulled.items.filter((item) => item.url && !item.publishedAt);
console.log(`memos: ${pulled.items.length}, without an original date: ${candidates.length}`);

const found = [];
const queue = [...candidates];
async function worker() {
  while (queue.length) {
    const item = queue.shift();
    let publishedAt = publishedFromUrl(item.url);
    let via = "address";
    if (!publishedAt) {
      via = "page";
      try {
        publishedAt = (await fetchPage(item.url)).publishedAt;
      } catch {
        publishedAt = "";
      }
    }
    // A date later than the save day is a page quirk (e.g. an event date), not the publish date.
    if (publishedAt && Date.parse(publishedAt) <= Date.parse(item.createdAt) + 86_400_000) found.push({ item, publishedAt, via });
  }
}
await Promise.all([worker(), worker(), worker(), worker()]);

const count = (via) => found.filter((entry) => entry.via === via).length;
console.log(`dates found: ${found.length} (address ${count("address")}, page ${count("page")}); unknown: ${candidates.length - found.length}`);
for (const entry of found.slice(0, 8)) console.log(`  ${entry.publishedAt.slice(0, 16).padEnd(16)} ${entry.via.padEnd(7)} ${entry.item.title.slice(0, 40)}`);

if (!apply) {
  console.log("dry run only. Run again with --apply to write.");
} else if (found.length) {
  const settings = await (await fetch(`${base}/api/settings`)).json();
  const vault = settings.storage?.vaultDir;
  if (vault) {
    const backup = path.join(path.dirname(vault), `${path.basename(vault)}-backup-${new Date().toISOString().slice(0, 10)}`);
    // Keep the first backup of the day: it was taken before any change was written.
    if (existsSync(backup)) console.log(`backup already exists: ${backup}`);
    else {
      await cp(vault, backup, { recursive: true });
      console.log(`backup: ${backup}`);
    }
  }
  const stamp = Date.now();
  const items = found.map((entry, index) => ({ ...entry.item, publishedAt: entry.publishedAt, updatedAt: new Date(stamp + index).toISOString() }));
  const response = await fetch(`${base}/api/sync/push`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items, deleted: [] }) });
  console.log("push:", await response.json());
}
