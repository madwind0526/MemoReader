// Storage layout tests: the notes folder is an Obsidian vault, and the same link never becomes two items.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { extractPage } from "../backend/fetch-page.mjs";
import { INBOX_FOLDER, createStore, noteFileName } from "../backend/store.mjs";
import { mediaKindOf, newId, normalizeTag, parseOrganizeResult, youtubeIdOf } from "../shared/item.mjs";

async function tempDir() {
  return mkdtemp(path.join(os.tmpdir(), "memoreader-vault-"));
}

// Relative paths of every note under the vault folder, with "/" separators.
async function vaultFiles(dir, vault = "vault_output") {
  const root = path.join(dir, vault);
  const found = [];
  const walk = async (folder) => {
    for (const child of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(folder, child.name);
      if (child.isDirectory()) await walk(full);
      else found.push(path.relative(root, full).split(path.sep).join("/"));
    }
  };
  await walk(root);
  return found.sort();
}

test("items move to their category folder and follow category and title changes", async () => {
  const dir = await tempDir();
  try {
    const store = await createStore(dir);
    const { item } = await store.create({ input: "메모" });
    const tail = `(${item.id.slice(-6)}).md`;
    assert.deepEqual(await vaultFiles(dir), [`${INBOX_FOLDER}/메모 ${tail}`], "new items wait in the inbox, named after their text");

    await store.update(item.id, { category: "네트워크/DNS", title: "DNS 정리", status: "done" });
    assert.deepEqual(await vaultFiles(dir), [`네트워크/DNS/DNS 정리 ${tail}`], "organized items are filed by category and titled");

    // Changing only the letter case must not delete the file on case-insensitive file systems.
    await store.update(item.id, { category: "네트워크/dns" });
    const reopened = await createStore(dir);
    assert.equal(reopened.get(item.id).category, "네트워크/dns");
    assert.equal((await reopened.readContent(item.id)).input, "메모");
    assert.equal((await vaultFiles(dir)).length, 1);

    await reopened.update(item.id, { category: "" });
    assert.deepEqual(await vaultFiles(dir), [`${INBOX_FOLDER}/DNS 정리 ${tail}`], "clearing the category returns it to the inbox");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("note names are Obsidian-safe", () => {
  const meta = { id: "20261012-070804-d31012", title: 'A/B: "C" #태그 [x] ^y | z?' };
  assert.equal(noteFileName(meta, ""), "A B C 태그 x y z (d31012).md");
  assert.equal(noteFileName({ ...meta, title: "" }, "원문 첫 줄\n둘째"), "원문 첫 줄 둘째 (d31012).md");
});

test("tags are normalized so they also work as Obsidian tags", () => {
  assert.equal(normalizeTag("#예약 도메인"), "예약-도메인");
  assert.equal(normalizeTag("Opus5.5"), "Opus5-5");
  assert.equal(normalizeTag("a/b"), "a/b");
  assert.equal(normalizeTag("2026"), "", "a tag cannot be only digits");
  assert.equal(normalizeTag(" -- "), "");
  const parsed = parseOrganizeResult('{"title":"t","summary":"s","category":"c","tags":["Motion Design","motion-design","UI/UX"]}');
  assert.deepEqual(parsed.tags, ["Motion-Design", "UI/UX"]);
});

test("the vault folder is shared with Obsidian: its own notes and folders are left alone", async () => {
  const dir = await tempDir();
  const vault = path.join(dir, "my-vault");
  try {
    await mkdir(path.join(vault, ".obsidian"), { recursive: true });
    await writeFile(path.join(vault, ".obsidian", "app.json"), "{}");
    await writeFile(path.join(vault, "내 일기.md"), "---\ntitle: mine\n---\n\n오늘 일기");
    const store = await createStore(dir, { vaultDir: vault });
    const { item } = await store.create({ input: "저장할 메모" });
    await store.update(item.id, { category: "개발", title: "제목" });

    const reopened = await createStore(dir, { vaultDir: vault });
    assert.equal(reopened.stats().total, 1, "only notes written by the app are loaded");
    assert.equal(await readFile(path.join(vault, "내 일기.md"), "utf8"), "---\ntitle: mine\n---\n\n오늘 일기", "foreign notes stay untouched");
    assert.ok(existsSync(path.join(vault, ".obsidian", "app.json")));
    assert.equal(reopened.vaultPath, path.resolve(vault));
    const note = await readFile(path.join(vault, "개발", `제목 (${item.id.slice(-6)}).md`), "utf8");
    assert.match(note, /^---\n/);
    assert.match(note, /\ntags: \[\]\n/);
    assert.match(note, /# 제목/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("notes from the old data/items layout move into the vault and old tags are normalized", async () => {
  const dir = await tempDir();
  try {
    const id = "20261012-070804-aaaaaa";
    const legacy = path.join(dir, "items", "2026-10");
    await mkdir(legacy, { recursive: true });
    const file = [
      "---",
      `id: "${id}"`,
      'status: "done"',
      'url: ""',
      'title: "옛 노트"',
      'category: "개발"',
      'tags: ["예약 도메인","Opus5.5"]',
      'createdAt: "2026-10-12T00:00:00.000Z"',
      'updatedAt: "2026-10-12T00:00:00.000Z"',
      "inputStart: 0",
      "---",
      "",
      "# 옛 노트",
      "",
    ].join("\n");
    await writeFile(path.join(legacy, `${id}.md`), file);

    const store = await createStore(dir);
    assert.ok(!existsSync(path.join(dir, "items", "2026-10", `${id}.md`)), "the old copy is gone");
    assert.deepEqual(await vaultFiles(dir), ["개발/옛 노트 (aaaaaa).md"]);
    const meta = store.get(id);
    assert.deepEqual(meta.tags, ["예약-도메인", "Opus5-5"]);
    assert.ok(meta.updatedAt > "2026-10-12T00:00:00.000Z", "a normalization counts as an edit so devices re-sync it");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the same link saved twice is merged, never duplicated and never loses text", async () => {
  const dir = await tempDir();
  try {
    const store = await createStore(dir);
    // Telegram saved it first.
    const first = await store.create({ input: "https://example.com/a", sourceRef: "tg:1:1", createdAt: "2026-10-12T01:00:00.000Z" });
    await store.update(first.item.id, { title: "정리됨", tags: ["a"], status: "done" });

    // A phone saved the same link (with its own note) before it had heard about the first save.
    const id = newId();
    const phone = {
      id,
      input: "내 메모 https://example.com/a?utm_source=x",
      url: "",
      source: "mobile",
      status: "pending",
      tags: ["b"],
      favorite: true,
      createdAt: "2026-10-12T00:30:00.000Z",
      updatedAt: "2026-10-12T00:30:00.000Z",
    };
    assert.equal(await store.upsertFromSync(phone), true);

    assert.equal(store.stats().total, 1, "one item remains");
    const merged = store.get(first.item.id);
    assert.equal(merged.createdAt, "2026-10-12T00:30:00.000Z", "the earlier save time is kept");
    assert.equal(merged.favorite, true);
    assert.deepEqual(merged.tags, ["a", "b"]);
    assert.equal(merged.title, "정리됨", "the organized result survives");
    const text = (await store.readContent(first.item.id)).input;
    assert.ok(text.includes("https://example.com/a") && text.includes("내 메모"), "both texts are kept");

    const changes = await store.changesSince("");
    assert.deepEqual(changes.deleted.map((entry) => entry.id), [id], "the phone is told to drop its copy");
    assert.equal(changes.items.length, 1);

    // The phone pushes its old copy again before it pulled the deletion: still one item.
    assert.equal(await store.upsertFromSync(phone), false);
    assert.equal(store.stats().total, 1);

    // Sending the link again with the same words changes nothing; with new words it appends them.
    const same = await store.create({ input: "https://example.com/a", sourceRef: "tg:1:2" });
    assert.equal(same.merged, false);
    const more = await store.create({ input: "https://example.com/a 나중에 꼭 읽기", sourceRef: "tg:1:3" });
    assert.equal(more.merged, true);
    assert.equal(store.stats().total, 1);
    assert.ok((await store.readContent(first.item.id)).input.includes("나중에 꼭 읽기"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("page extraction finds a video file, the preview picture and article pictures", () => {
  const html = `<html><head>
    <meta property="og:image" content="/cover.jpg">
    <meta property="og:video:secure_url" content="https://cdn.example.com/clip.mp4?token=1">
    <meta property="og:video" content="https://www.youtube.com/embed/abcdefghijk"></head>
    <body><article>
      <img src="/img/photo-1.jpg" width="800"><img src="/img/logo.png"><img src="data:image/gif;base64,AAAA">
      <img data-src="https://cdn.example.com/photo-2.webp"><img src="/img/tiny.jpg" width="16" height="16">
      <img src="/cover.jpg"><p>${"본문 ".repeat(120)}</p></article></body></html>`;
  const page = extractPage(html, "https://example.com/post");
  assert.equal(page.image, "https://example.com/cover.jpg");
  assert.equal(page.video, "https://cdn.example.com/clip.mp4?token=1", "only a real video file counts, not an embed page");
  assert.deepEqual(page.images, ["https://example.com/img/photo-1.jpg", "https://cdn.example.com/photo-2.webp"]);
  assert.equal(mediaKindOf("https://x.com/a/b.PNG?w=1"), "image");
  assert.equal(mediaKindOf("https://x.com/a/b.mp4"), "video");
  assert.equal(mediaKindOf("https://x.com/a/b"), "");
  assert.equal(youtubeIdOf("https://youtu.be/dQw4w9WgXcQ?t=3"), "dQw4w9WgXcQ");
  assert.equal(youtubeIdOf("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=x"), "dQw4w9WgXcQ");
  assert.equal(youtubeIdOf("https://www.youtube.com/shorts/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  assert.equal(youtubeIdOf("https://example.com/watch?v=dQw4w9WgXcQ"), "");
});
