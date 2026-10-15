import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createApp } from "../backend/app.mjs";
import { screenTexts } from "../backend/screen.mjs";
import { newId } from "../shared/item.mjs";
import { classifyMessage, parseKakaoExport, snippet } from "../shared/kakao.mjs";

const EXPORT = [
  "미친바람 님과 카카오톡 대화",
  "저장한 날짜 : 2026년 10월 13일 오후 9:29",
  "",
  "",
  "2016년 6월 7일 오전 11:00",
  "2016년 6월 7일 오전 11:00, 미친바람 : [Tistory]",
  "제주도 추천",
  "http://example.com/jeju",
  "2018년 2월 10일 오후 11:06, 미친바람 : 집에 가는 길에 우유 사기",
  "2018년 5월 6일 오후 6:05",
  "2018년 5월 6일 오후 6:05, 미친바람 : https://youtu.be/cKdSaLt6w7s",
  "2018년 5월 6일 오후 6:06, 미친바람 : 사진 3장",
  `2018년 5월 7일 오후 12:30, 미친바람 : ${"긴 프롬프트 ".repeat(40)}`,
].join("\n");

test("a KakaoTalk export is read with times, multi-line messages and noise lines", () => {
  const messages = parseKakaoExport(EXPORT);
  assert.equal(messages.length, 5);
  assert.deepEqual(messages[0].at, new Date(2016, 5, 7, 11, 0));
  assert.equal(messages[0].text, "[Tistory]\n제주도 추천\nhttp://example.com/jeju");
  assert.deepEqual(messages[2].at, new Date(2018, 4, 6, 18, 5)); // 오후 6:05 is 18:05
  assert.equal(parseKakaoExport("2018년 5월 6일 오전 12:10, 나 : 자정 직후").at(0).at.getHours(), 0);
});

test("messages are sorted into link, long, short and photo/deleted notices", () => {
  assert.equal(classifyMessage("보세요 https://a.com/x"), "link");
  assert.equal(classifyMessage("가".repeat(150)), "long");
  assert.equal(classifyMessage("가".repeat(149)), "short");
  assert.equal(classifyMessage("가".repeat(149), 100), "long");
  assert.equal(classifyMessage("사진 3장"), "system");
  assert.equal(classifyMessage("삭제된 메시지입니다."), "system");
  assert.equal(snippet("a  b\nc", 10), "a b c");
  assert.equal(snippet("x".repeat(20), 5), "xxxxx…");
});

test("screening returns one keep flag per text and rejects an oversized batch", async () => {
  const llm = { complete: async (_system, user, { accept }) => (accept('{"keep":[1,3]}'), '{"keep":[1,3]}') };
  assert.deepEqual(await screenTexts(llm, ["a", "b", "c"]), [true, false, true]);
  assert.deepEqual(await screenTexts(llm, []), []);
  await assert.rejects(screenTexts(llm, new Array(26).fill("x")), /25/);
  await assert.rejects(screenTexts({ complete: async () => "no json here" }, ["a"]));
});

test("the import screen endpoint judges texts through the configured LLM", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "memoreader-import-"));
  const app = await createApp({ dataDir: dir, env: {}, log: { warn() {}, error() {}, info() {} }, createLlm: () => ({ complete: async () => '{"keep":[2]}' }) });
  const { port } = await app.listen(0);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/import/screen`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ texts: ["오늘 저녁 메모", "프롬프트 모음"] }) });
    assert.deepEqual(await response.json(), { ok: true, keep: [false, true] });
  } finally {
    await app.close?.();
    await rm(dir, { recursive: true, force: true });
  }
});

test("import files: a Kakao chat keeps its message times, other files become one post each or are split", async () => {
  const { parseImportFile, htmlToText } = await import("../shared/import-text.mjs");

  const kakao = parseImportFile({ name: "chat.txt", text: "2024년 5월 7일 오후 6:39, 나 : 첫 메모\n이어지는 줄\n2024년 5월 8일 오전 9:05, 나 : 둘째" });
  assert.equal(kakao.format, "kakao");
  assert.equal(kakao.entries.length, 2);
  assert.equal(kakao.entries[0].text, "첫 메모\n이어지는 줄");
  assert.equal(kakao.entries[0].at.getHours(), 18);

  // One note with front matter: title and date come from the header.
  const note = parseImportFile({ name: "post.md", text: "---\ntitle: 제주 여행\ndate: 2023-04-02\n---\n\n본문 한 줄\n\n---\n\n본문 둘째" });
  assert.equal(note.format, "markdown");
  assert.equal(note.entries.length, 1);
  assert.equal(note.entries[0].title, "제주 여행");
  assert.equal(note.entries[0].at.getFullYear(), 2023);
  assert.match(note.entries[0].text, /본문 둘째/);

  // Separator lines split one text file into several posts.
  const split = parseImportFile({ name: "notes.txt", text: "2022.03.01\n첫 글\n\n---\n\n둘째 글\n\n---\n\n셋째 글" });
  assert.equal(split.format, "text");
  assert.deepEqual(split.entries.map((entry) => entry.text.split("\n")[0]), ["2022.03.01", "둘째 글", "셋째 글"]);
  assert.equal(split.entries[0].at.getMonth(), 2);

  // "# " headings split a Markdown file when there are several, and name each post.
  const headings = parseImportFile({ name: "all.md", text: "# 하나\n내용 1\n\n# 둘\n내용 2" });
  assert.deepEqual(headings.entries.map((entry) => entry.title), ["하나", "둘"]);

  // A whole file without any marker stays one post.
  assert.equal(parseImportFile({ name: "one.txt", text: "그냥 긴 글\n\n두 번째 문단" }).entries.length, 1);

  const html = parseImportFile({
    name: "post.html",
    text: '<html><head><title>블로그 &amp; 글</title><meta property="article:published_time" content="2021-06-05T10:00:00+09:00"><script>x()</script></head><body><article><h1>제목</h1><p>첫 문단</p><p>둘째&nbsp;문단</p></article></body></html>',
  });
  assert.equal(html.format, "html");
  assert.equal(html.entries[0].title, "블로그 & 글");
  assert.equal(html.entries[0].at.getFullYear(), 2021);
  assert.equal(html.entries[0].text, "제목\n첫 문단\n둘째 문단");

  const xml = parseImportFile({
    name: "backup.xml",
    text: '<?xml version="1.0"?><rss><channel><item><title><![CDATA[첫 글]]></title><pubDate>Tue, 10 Jan 2023 09:00:00 +0900</pubDate><content:encoded><![CDATA[<p>본문 <b>하나</b></p>]]></content:encoded></item><item><title>둘째</title><wp:post_date>2022-02-03 11:00:00</wp:post_date><content:encoded><![CDATA[둘째 본문]]></content:encoded></item></channel></rss>',
  });
  assert.equal(xml.format, "xml");
  assert.deepEqual(xml.entries.map((entry) => [entry.title, entry.text]), [["첫 글", "본문 하나"], ["둘째", "둘째 본문"]]);
  assert.equal(xml.entries[0].at.getFullYear(), 2023);

  const json = parseImportFile({ name: "dump.json", text: JSON.stringify({ posts: [{ title: "A", content: "<p>가</p>", createdAt: "2020-01-02" }, { text: "나" }, { nothing: 1 }] }) });
  assert.equal(json.format, "json");
  assert.deepEqual(json.entries.map((entry) => entry.text), ["가", "나"]);
  assert.equal(json.entries[1].at, null);

  assert.equal(htmlToText("<style>a{}</style>a<br>b&#65;&lt;"), "a\nbA<");
});

test("an imported article that mentions an address is not turned into a link memo", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "memoreader-import-file-"));
  const app = await createApp({ dataDir: dir, env: {}, log: { warn() {}, error() {} }, announceStart: false, fetchPage: async () => { throw new Error("must not fetch"); } });
  try {
    const now = new Date().toISOString();
    const base = { status: "done", category: "", tags: [], createdAt: now, updatedAt: now, summary: "", title: "t" };
    const text = "긴 글입니다. 참고: https://example.com/ref 를 보세요.";
    const fileId = newId();
    const chatId = newId(new Date(Date.now() + 5000));
    await app.store.upsertFromSync({ ...base, id: fileId, source: "file", url: "", input: text });
    await app.store.upsertFromSync({ ...base, id: chatId, source: "kakao", url: "", input: text });
    assert.equal(app.store.get(fileId).url, "", "file imports keep what the client decided");
    assert.equal(app.store.get(chatId).url, "https://example.com/ref", "chat messages still take the address from the text");
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
