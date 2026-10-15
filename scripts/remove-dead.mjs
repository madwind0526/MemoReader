// Finds memos whose original is gone and removes them:
//   - YouTube videos that no longer play (checked with YouTube's public oEmbed endpoint)
//   - "service ended" notice pages (e.g. flip.it links) and pages that only say the post was deleted
// Dry run by default. Pass --apply to delete; the vault is copied to a backup first.
//   node scripts/remove-dead.mjs [--apply] [--base http://127.0.0.1:4313]
import { existsSync } from "node:fs";
import { cp } from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const base = args.includes("--base") ? args[args.indexOf("--base") + 1] : "http://127.0.0.1:4313";

const items = [];
let cursor = "";
for (;;) {
  const page = await (await fetch(`${base}/api/sync/pull?limit=200&cursor=${encodeURIComponent(cursor)}`)).json();
  items.push(...page.items);
  if (!page.hasMore || !page.cursor || page.cursor === cursor) break;
  cursor = page.cursor;
}

const dead = new Map(); // id -> { item, why }

// 1. notice pages, judged from what the organizer wrote about the page (only organized memos)
const SERVICE_ENDED = /서비스\s*종료\s*안내|서비스\s*종료된|링크\s*서비스\s*종료|종료된\s*(서비스|Flipboard)/i;
const DELETED = /삭제된\s*(메시지|메세지|게시물|글|트윗|포스트|영상|동영상)|(게시물|메시지|메세지|글|영상|동영상)(이|가)\s*삭제|존재하지\s*않는\s*(게시물|페이지|글)|이\s*(콘텐츠|게시물)(은|는)?\s*(삭제|볼\s*수\s*없|사용할\s*수\s*없)/;
for (const item of items) {
  if (item.status !== "done") continue;
  if (SERVICE_ENDED.test(item.title)) dead.set(item.id, { item, why: "서비스 종료 안내" });
  else if (DELETED.test(item.title) || (item.page.length < 600 && DELETED.test(item.summary.slice(0, 200)))) dead.set(item.id, { item, why: "삭제된 글" });
}

// 2. YouTube: oEmbed answers 404 (removed) or 401 (private). 403 only means embedding is disabled, so it is kept
function youtubeUrl(raw) {
  try {
    const url = new URL(raw);
    const host = url.hostname.replace(/^www\.|^m\./, "");
    if (host === "youtu.be") return url.pathname.length > 1 ? `https://www.youtube.com/watch?v=${url.pathname.slice(1)}` : "";
    if (host.endsWith("youtube.com")) {
      if (url.pathname === "/watch" && url.searchParams.get("v")) return `https://www.youtube.com/watch?v=${url.searchParams.get("v")}`;
      const shorts = /^\/(shorts|live|embed)\/([\w-]+)/.exec(url.pathname);
      if (shorts) return `https://www.youtube.com/watch?v=${shorts[2]}`;
    }
  } catch {
    // not a url
  }
  return "";
}

const videos = items.map((item) => ({ item, watch: youtubeUrl(item.url) })).filter((entry) => entry.watch);
const queue = [...videos];
const checked = { alive: 0, gone: 0, unknown: 0 };
async function worker() {
  while (queue.length) {
    const { item, watch } = queue.shift();
    try {
      const response = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(watch)}&format=json`, { signal: AbortSignal.timeout(15000) });
      if (response.ok) checked.alive += 1;
      else if ([401, 404].includes(response.status)) {
        checked.gone += 1;
        dead.set(item.id, { item, why: `YouTube 재생 불가 (${response.status})` });
      } else checked.unknown += 1;
    } catch {
      checked.unknown += 1; // network trouble is never a reason to delete
    }
  }
}
await Promise.all([worker(), worker(), worker(), worker()]);
console.log(`memos: ${items.length}; YouTube checked: ${videos.length} (playable ${checked.alive}, not playable ${checked.gone}, could not check ${checked.unknown})`);
console.log(`to delete: ${dead.size}`);
for (const { item, why } of dead.values()) console.log(`  [${why}] ${item.category || "-"} | ${(item.title || "(제목 없음)").slice(0, 44)} | ${item.url.slice(0, 50)}`);

if (!apply) {
  console.log("\ndry run only. Run again with --apply to delete.");
} else if (dead.size) {
  const settings = await (await fetch(`${base}/api/settings`)).json();
  const current = settings.storage?.vaultDir;
  if (current) {
    const backup = path.join(path.dirname(current), `${path.basename(current)}-backup-before-remove-dead`);
    if (existsSync(backup)) console.log(`backup already exists: ${backup}`);
    else {
      await cp(current, backup, { recursive: true });
      console.log(`backup: ${backup}`);
    }
  }
  const deletedAt = new Date().toISOString();
  const response = await fetch(`${base}/api/sync/push`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items: [], deleted: [...dead.keys()].map((id) => ({ id, deletedAt })) }) });
  console.log("deleted:", await response.json());
}
