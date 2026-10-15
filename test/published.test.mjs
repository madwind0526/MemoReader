import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createApp } from "../backend/app.mjs";
import { extractPage } from "../backend/fetch-page.mjs";
import { cleanMeta } from "../backend/store.mjs";
import { newId, normalizePublishedAt, parseLooseDate, publishedFromUrl } from "../shared/item.mjs";
import { sortItems } from "../shared/sort.mjs";

const quiet = { warn() {}, error() {}, info() {} };
const answer = (extra = {}) => JSON.stringify({ title: "제목", summary: "요약", category: "개발", tags: ["a"], ...extra });

test("publish dates are accepted only when they are real full dates", () => {
  assert.equal(normalizePublishedAt("2026-09-12"), "2026-09-12");
  assert.equal(normalizePublishedAt("2026-09-12T14:30:00+09:00"), "2026-09-12T05:30:00.000Z");
  for (const bad of ["2026", "2026-13-40", "yesterday", "", "1999-01-01", undefined]) assert.equal(normalizePublishedAt(bad), "");
  assert.equal(parseLooseDate("239 likes - August 28, 2026"), "2026-08-28");
  assert.equal(parseLooseDate("2026년 9월 9일 작성"), "2026-09-09");
});

test("Instagram, Threads and X addresses carry the post time", () => {
  assert.match(publishedFromUrl("https://x.com/someone/status/1700000000000000000"), /^2023-09-/);
  assert.equal(publishedFromUrl("https://example.com/post"), "");
});

test("extractPage reads the publish date from meta, JSON-LD, time tags and Instagram text", () => {
  const meta = extractPage('<meta property="article:published_time" content="2026-09-01T10:00:00+09:00"><body>x</body>', "https://a.com/p");
  assert.equal(meta.publishedAt, "2026-09-01T01:00:00.000Z");
  const ld = extractPage('<script type="application/ld+json">{"@graph":[{"datePublished":"2026-08-20"}]}</script><body>x</body>', "https://a.com/p");
  assert.equal(ld.publishedAt, "2026-08-20");
  const time = extractPage('<body><time datetime="2026-07-05">July</time></body>', "https://a.com/p");
  assert.equal(time.publishedAt, "2026-07-05");
  const bareYear = extractPage('<body><time datetime="2026">2026</time></body>', "https://a.com/p");
  assert.equal(bareYear.publishedAt, "");
  const insta = extractPage('<meta property="og:description" content="239 likes, 1 comments - luxi - August 28, 2026: caption">', "https://www.instagram.com/p/abc/");
  assert.equal(insta.publishedAt, "2026-08-28");
  assert.equal(extractPage("<body>nothing</body>", "https://a.com/p").publishedAt, "");
});

test("cleanMeta drops a publish date that is after the day the memo was saved", () => {
  const base = { id: newId(), createdAt: "2026-09-10T00:00:00.000Z" };
  assert.equal(cleanMeta({ ...base, publishedAt: "2026-09-09" }).publishedAt, "2026-09-09");
  assert.equal(cleanMeta({ ...base, publishedAt: "2026-10-01" }).publishedAt, "");
  assert.equal(cleanMeta({ ...base, publishedAt: "soon" }).publishedAt, "");
});

test("sorting by original date falls back to the saved time", () => {
  const items = [
    { id: "a", createdAt: "2026-09-10T00:00:00.000Z", publishedAt: "2026-01-01" },
    { id: "b", createdAt: "2026-09-05T00:00:00.000Z", publishedAt: "" },
    { id: "c", createdAt: "2026-09-01T00:00:00.000Z", publishedAt: "2026-09-08" },
  ];
  assert.deepEqual(sortItems(items, "published").map((item) => item.id), ["c", "b", "a"]);
});

async function organizeOne({ url, fetched, llm, createdAt, publishedAt }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "memoreader-pub-"));
  const app = await createApp({
    dataDir: dir,
    env: {},
    log: quiet,
    fetchPage: async () => ({ title: "", description: "", image: "", siteName: "", text: "page text", ...fetched }),
    createLlm: () => ({ complete: async () => answer(llm) }),
  });
  try {
    const { item } = await app.store.create({ input: url, url, createdAt, publishedAt });
    app.organizer.enqueue(item.id);
    await app.organizer.idle();
    return app.store.get(item.id);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("publish date priority: address, then page, then forwarded date, then the model", async () => {
  const now = new Date().toISOString();
  const fromPage = await organizeOne({ url: "https://example.com/a", fetched: { publishedAt: "2026-08-01" }, llm: { publishedAt: "2026-02-02" }, createdAt: now });
  assert.equal(fromPage.publishedAt, "2026-08-01");

  const forwarded = await organizeOne({ url: "https://example.com/b", fetched: {}, llm: { publishedAt: "2026-02-02" }, createdAt: now, publishedAt: "2026-07-07T00:00:00.000Z" });
  assert.equal(forwarded.publishedAt, "2026-07-07T00:00:00.000Z");

  const fromModel = await organizeOne({ url: "https://example.com/c", fetched: {}, llm: { publishedAt: "2026-02-02" }, createdAt: now });
  assert.equal(fromModel.publishedAt, "2026-02-02");

  const unknown = await organizeOne({ url: "https://example.com/d", fetched: {}, llm: {}, createdAt: now });
  assert.equal(unknown.publishedAt, "");
});
