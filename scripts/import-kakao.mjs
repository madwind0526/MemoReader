// Command-line version of the import screen: saves links and long pasted texts (prompts, articles) from a
// KakaoTalk "chat with myself" export. Kept: messages with a link, and link-less messages that are long.
// The message time becomes the memo's save time; the server organizes each memo.
// Dry run by default. Pass --apply to import; the current vault is copied to a backup first.
//   node scripts/import-kakao.mjs <export.txt> [--min-chars 150] [--classify] [--apply] [--base http://127.0.0.1:4313]
import { existsSync } from "node:fs";
import { cp, readFile } from "node:fs/promises";
import path from "node:path";

import { createFallbackClient } from "../backend/llm.mjs";
import { SCREEN_BATCH, screenTexts } from "../backend/screen.mjs";
import { createSettings } from "../backend/settings.mjs";
import { extractFirstUrl, newId, normalizeUrl } from "../shared/item.mjs";
import { classifyMessage, parseKakaoExport } from "../shared/kakao.mjs";

const args = process.argv.slice(2);
const flag = (name, fallback = "") => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const file = args.find((arg, index) => !arg.startsWith("--") && !["--min-chars", "--base"].includes(args[index - 1]));
const minChars = Number(flag("--min-chars", "150"));
const apply = args.includes("--apply");
const base = flag("--base", "http://127.0.0.1:4313");
if (!file) {
  console.error("usage: node scripts/import-kakao.mjs <export.txt> [--min-chars 150] [--classify] [--apply]");
  process.exit(1);
}

const messages = parseKakaoExport(await readFile(file, "utf8"));
const kept = messages.map((message) => ({ ...message, kind: classifyMessage(message.text, minChars) })).filter((message) => message.kind === "link" || message.kind === "long");
const longOnes = kept.filter((entry) => entry.kind === "long");
console.log(`messages: ${messages.length}; kept: ${kept.length} (links ${kept.length - longOnes.length}, long texts ${longOnes.length}, min ${minChars} chars)`);

// Long texts without a link are judged by the LLM; decisions are cached so a rerun is free.
if (longOnes.length && (apply || args.includes("--classify"))) {
  const dataDir = path.resolve(import.meta.dirname, "..", "data");
  const cache = path.join(dataDir, "kakao-long-decisions.json");
  let decisions = {};
  try {
    decisions = JSON.parse(await readFile(cache, "utf8"));
  } catch {
    // first run
  }
  const key = (entry) => `${entry.at.toISOString()}|${entry.text.length}`;
  const todo = longOnes.filter((entry) => !(key(entry) in decisions));
  if (todo.length) {
    const llm = createFallbackClient((await createSettings(dataDir)).get().llm);
    for (let start = 0; start < todo.length; start += SCREEN_BATCH) {
      const batch = todo.slice(start, start + SCREEN_BATCH);
      const keep = await screenTexts(llm, batch.map((entry) => entry.text));
      batch.forEach((entry, index) => {
        decisions[key(entry)] = keep[index];
      });
      console.log(`  judged ${Math.min(start + SCREEN_BATCH, todo.length)}/${todo.length}`);
    }
    const { writeFile } = await import("node:fs/promises");
    await writeFile(cache, JSON.stringify(decisions, null, 1));
  }
  const dropped = longOnes.filter((entry) => decisions[key(entry)] === false);
  console.log(`long texts: keep ${longOnes.length - dropped.length}, dropped as everyday notes ${dropped.length}`);
  for (const entry of dropped) kept.splice(kept.indexOf(entry), 1);
}
console.log(`will import: ${kept.length}`);

if (!apply) {
  console.log("dry run only. Run again with --apply to import.");
} else {
  const pulled = await (await fetch(`${base}/api/sync/pull?limit=200`)).json();
  const known = new Set(pulled.items.map((item) => item.sourceRef).filter(Boolean));
  const now = Date.now();
  const items = [];
  kept.forEach((entry, index) => {
    const sourceRef = `kakao:${entry.at.toISOString().slice(0, 16)}:${index}`;
    if (known.has(sourceRef)) return;
    const link = extractFirstUrl(entry.text);
    items.push({
      id: newId(),
      status: "pending",
      source: "kakao",
      sourceRef,
      url: link ? normalizeUrl(link) : "",
      title: "",
      createdAt: new Date(Math.min(entry.at.getTime(), now)).toISOString(),
      updatedAt: new Date(now + items.length).toISOString(),
      input: entry.text,
    });
  });
  const settings = await (await fetch(`${base}/api/settings`)).json();
  const current = settings.storage?.vaultDir;
  if (current) {
    const backup = path.join(path.dirname(current), `${path.basename(current)}-backup-before-kakao-import`);
    if (existsSync(backup)) console.log(`backup already exists: ${backup}`);
    else {
      await cp(current, backup, { recursive: true });
      console.log(`backup: ${backup}`);
    }
  }
  let applied = 0;
  for (let index = 0; index < items.length; index += 20) {
    const response = await fetch(`${base}/api/sync/push`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items: items.slice(index, index + 20), deleted: [] }) });
    applied += (await response.json()).applied ?? 0;
  }
  console.log(`pushed: ${applied} of ${items.length}`);
}
