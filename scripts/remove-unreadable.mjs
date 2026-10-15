// Removes 기타 memos whose link could not be read and never will be: login walls, deleted pages,
// site error pages, unreachable sites, and Naver blog posts (their text sits in an iframe we do not read).
// Only memos whose stored page text is a stub are considered. Facebook memos are only removed when
// their page is a login screen, not when the post is merely "not available".
// Dry run by default. Pass --apply to delete; the vault is copied to a backup first.
//   node scripts/remove-unreadable.mjs [--apply] [--skip-network] [--base http://127.0.0.1:4313]
import { existsSync } from "node:fs";
import { cp } from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const skipNetwork = args.includes("--skip-network");
const base = args.includes("--base") ? args[args.indexOf("--base") + 1] : "http://127.0.0.1:4313";
const STUB_CHARS = 600;

const items = [];
let cursor = "";
for (;;) {
  const page = await (await fetch(`${base}/api/sync/pull?limit=200&cursor=${encodeURIComponent(cursor)}`)).json();
  items.push(...page.items);
  if (!page.hasMore || !page.cursor || page.cursor === cursor) break;
  cursor = page.cursor;
}

const LOGIN = /로그인|가입하기|log\s?in|sign\s?in|sign\s?up/i;
const NOT_FOUND = /찾을\s*수\s*없|존재하지\s*않|삭제된|페이지가\s*없|not\s*found|404/i;
const SYSTEM_ERROR = /에러\s*페이지|시스템\s*오류|서비스\s*접속이\s*불가|접속이\s*불가|일시적인\s*오류|서비스\s*점검/i;

// Only social sites hide their posts behind a login wall. A company login portal saved as a bookmark is not unreadable.
const LOGIN_WALL_HOSTS = /(^|\.)(facebook\.com|fb\.watch|instagram\.com|threads\.com|threads\.net|flip\.it)$/;
const FACEBOOK_HOSTS = /(^|\.)(facebook\.com|fb\.watch|fb\.com)$/;
const VIDEO_HOSTS = /(^|\.)(youtube\.com|youtu\.be|vimeo\.com)$/;

function hostOf(raw) {
  try {
    return new URL(raw).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

const candidates = items.filter((item) => item.status === "done" && item.category === "기타" && item.url && (item.page ?? "").length < STUB_CHARS);
const remove = new Map(); // id -> { item, why }
const unchecked = [];

for (const item of candidates) {
  const host = hostOf(item.url);
  const page = item.page ?? "";
  // Videos are judged by their own title and player, not by a stub page, so they are never removed here.
  if (VIDEO_HOSTS.test(host)) continue;
  // Facebook posts are kept for now: the owner decides separately (they may open when logged in).
  if (FACEBOOK_HOSTS.test(host)) continue;
  if (/(^|\.)blog\.naver\.com$/.test(host) || /네이버\s*블로그/.test(page.slice(-40))) remove.set(item.id, { item, why: "네이버 블로그" });
  else if (SYSTEM_ERROR.test(page)) remove.set(item.id, { item, why: "시스템 오류 페이지" });
  else if (NOT_FOUND.test(page)) remove.set(item.id, { item, why: "페이지 없음" });
  else if (LOGIN.test(page) && LOGIN_WALL_HOSTS.test(host)) remove.set(item.id, { item, why: "로그인 화면" });
  else unchecked.push(item);
}

// Unreachable sites: only a connection-level failure counts, tried twice. An HTTP answer (even an error) is not "unreachable".
async function unreachable(url) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await fetch(url, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(15_000) });
      return false;
    } catch (error) {
      const code = error?.cause?.code ?? error?.name ?? "";
      if (!/ENOTFOUND|ETIMEDOUT|ECONNREFUSED|ECONNRESET|UND_ERR_CONNECT_TIMEOUT|TimeoutError|EAI_AGAIN/i.test(code)) return false;
    }
  }
  return true;
}

if (!skipNetwork) {
  const queue = [...unchecked];
  async function worker() {
    while (queue.length) {
      const item = queue.shift();
      if (await unreachable(item.url)) remove.set(item.id, { item, why: "접속 시간 초과" });
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()]);
}

const byWhy = new Map();
for (const { item, why } of remove.values()) byWhy.set(why, [...(byWhy.get(why) ?? []), item]);
console.log(`기타 memos with a stub page: ${candidates.length}; to delete: ${remove.size}`);
for (const [why, list] of byWhy) {
  const facebook = list.filter((item) => /facebook\.com$/.test(hostOf(item.url))).length;
  console.log(`\n[${why}] ${list.length}${facebook ? ` (facebook ${facebook})` : ""}`);
  for (const item of list) console.log(`  ${(item.title || "(제목 없음)").slice(0, 40)} | ${item.url.slice(0, 60)}`);
}

const facebookLeft = candidates.filter((item) => /facebook\.com$/.test(hostOf(item.url)) && !remove.has(item.id)).length;
console.log(`\nfacebook memos in 기타 with a stub page that are kept: ${facebookLeft}`);

if (!apply) {
  console.log("dry run only. Run again with --apply to delete.");
} else if (remove.size) {
  const settings = await (await fetch(`${base}/api/settings`)).json();
  const current = settings.storage?.vaultDir;
  if (current) {
    const backup = path.join(path.dirname(current), `${path.basename(current)}-backup-before-remove-unreadable`);
    if (existsSync(backup)) console.log(`backup already exists: ${backup}`);
    else {
      await cp(current, backup, { recursive: true });
      console.log(`backup: ${backup}`);
    }
  }
  const deletedAt = new Date().toISOString();
  const response = await fetch(`${base}/api/sync/push`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items: [], deleted: [...remove.keys()].map((id) => ({ id, deletedAt })) }) });
  console.log("deleted:", await response.json());
}
