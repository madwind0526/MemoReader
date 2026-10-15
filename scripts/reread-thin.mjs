// Queues memos whose page text is only a stub (so they were organized from almost nothing) to be read
// again, this time with the headless browser when a plain download is not enough. The organizer rereads
// the page for any memo whose stored page text is a stub, so this only has to mark them pending.
// Dry run by default. Pass --apply to queue them; the vault is copied to a backup first.
//   node scripts/reread-thin.mjs [--apply] [--limit N] [--host facebook.com] [--base http://127.0.0.1:4313]
import { existsSync } from "node:fs";
import { cp } from "node:fs/promises";
import path from "node:path";

import { needsRender } from "../backend/render-page.mjs";
import { mediaKindOf } from "../shared/item.mjs";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const base = args.includes("--base") ? args[args.indexOf("--base") + 1] : "http://127.0.0.1:4313";
const onlyHost = args.includes("--host") ? args[args.indexOf("--host") + 1] : "";
const limit = args.includes("--limit") ? Number(args[args.indexOf("--limit") + 1]) : Infinity;

const items = [];
let cursor = "";
for (;;) {
  const page = await (await fetch(`${base}/api/sync/pull?limit=200&cursor=${encodeURIComponent(cursor)}`)).json();
  items.push(...page.items);
  if (!page.hasMore || !page.cursor || page.cursor === cursor) break;
  cursor = page.cursor;
}

// Only memos with a web link whose organizing had almost no page to go on. Pasted texts without a link are left alone.
const thin = items
  .filter((item) => item.status === "done" && item.url && !mediaKindOf(item.url) && needsRender({ text: item.page }))
  .filter((item) => !onlyHost || new URL(item.url).hostname.replace(/^www\.|^m\./, "").endsWith(onlyHost))
  .slice(0, limit);

const byHost = new Map();
for (const item of thin) {
  const host = new URL(item.url).hostname.replace(/^www\.|^m\./, "");
  byHost.set(host, (byHost.get(host) ?? 0) + 1);
}
console.log(`memos: ${items.length}; link memos with a stub page: ${thin.length}`);
console.log(`  ${[...byHost].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([host, count]) => `${host} ${count}`).join(", ")}`);
const inOther = thin.filter((item) => item.category === "기타").length;
console.log(`  of these in 기타: ${inOther}`);

if (!apply) {
  console.log("dry run only. Run again with --apply to queue them.");
} else if (thin.length) {
  const settings = await (await fetch(`${base}/api/settings`)).json();
  const current = settings.storage?.vaultDir;
  if (current) {
    const backup = path.join(path.dirname(current), `${path.basename(current)}-backup-before-reread`);
    if (existsSync(backup)) console.log(`backup already exists: ${backup}`);
    else {
      await cp(current, backup, { recursive: true });
      console.log(`backup: ${backup}`);
    }
  }
  const stamp = Date.now();
  const payload = thin.map((item, index) => ({ ...item, status: "pending", error: "", updatedAt: new Date(stamp + index).toISOString() }));
  let applied = 0;
  for (let index = 0; index < payload.length; index += 20) {
    const response = await fetch(`${base}/api/sync/push`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items: payload.slice(index, index + 20), deleted: [] }) });
    applied += (await response.json()).applied ?? 0;
  }
  console.log(`queued: ${applied} of ${payload.length}`);
}
