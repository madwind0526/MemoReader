import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { authorize, sameOriginWrite } from "../backend/auth.mjs";
import { createApp } from "../backend/app.mjs";
import { extractPage, isPrivateAddress } from "../backend/fetch-page.mjs";
import { createPush, isAllowedEndpoint } from "../backend/push.mjs";
import { parseFrontmatter, serializeFrontmatter } from "../backend/frontmatter.mjs";
import { INBOX_FOLDER, categoryFolder, createStore } from "../backend/store.mjs";
import { buildOrganizePrompts, extractFirstUrl, newId, normalizeUrl, parseOrganizeResult } from "../shared/item.mjs";

async function tempDir() {
  return mkdtemp(path.join(os.tmpdir(), "memoreader-test-"));
}

const quiet = { warn() {}, error() {} };

test("frontmatter round-trips quotes, newlines and arrays", () => {
  const meta = { title: 'He said "hi"', summary: "line1\nline2", tags: ["a", "b c"], favorite: true };
  const parsed = parseFrontmatter(serializeFrontmatter(meta, "body"));
  assert.deepEqual(parsed.meta, meta);
  assert.equal(parsed.body, "body");
});

test("normalizeUrl strips tracking params and fragments", () => {
  assert.equal(normalizeUrl("https://Example.com/a?utm_source=x&id=1#top"), "https://example.com/a?id=1");
  assert.equal(normalizeUrl("javascript:alert(1)"), "");
  assert.equal(extractFirstUrl("see https://example.com/x, thanks"), "https://example.com/x");
});

test("store keeps the original text byte-for-byte, even with marker-like content", async () => {
  const dir = await tempDir();
  try {
    const store = await createStore(dir);
    const input = "원문 <!-- memoreader:input -->\n## 링크 본문\n끝\r\n";
    const { item } = await store.create({ input });
    await store.update(item.id, { title: "t" }, { page: "page <!-- memoreader:page -->\ntext" });
    const reopened = await createStore(dir);
    const content = await reopened.readContent(item.id);
    assert.equal(content.input, input);
    assert.equal(content.page, "page <!-- memoreader:page -->\ntext");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("categoryFolder builds safe, nested folder paths", () => {
  assert.deepEqual(categoryFolder(""), [INBOX_FOLDER]);
  assert.deepEqual(categoryFolder("개발"), ["개발"]);
  assert.deepEqual(categoryFolder("네트워크/DNS"), ["네트워크", "DNS"]);
  assert.deepEqual(categoryFolder('a:b*c?"d'), ["a_b_c__d"]);
  assert.deepEqual(categoryFolder("../.."), [INBOX_FOLDER]);
  assert.deepEqual(categoryFolder("con"), ["con_"]);
  assert.equal(categoryFolder("a/b/c/d/e").length, 3);
});

test("store de-duplicates the same link and the same Telegram message", async () => {
  const dir = await tempDir();
  try {
    const store = await createStore(dir);
    const first = await store.create({ input: "https://example.com/a?utm_source=x" });
    const second = await store.create({ input: "again https://example.com/a" });
    assert.equal(second.duplicate, true);
    assert.equal(second.item.id, first.item.id);
    const a = await store.create({ input: "hello", sourceRef: "tg:1:2" });
    const b = await store.create({ input: "hello again", sourceRef: "tg:1:2" });
    assert.equal(b.item.id, a.item.id);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sync: last writer wins, deletes propagate, older pushes are ignored", async () => {
  const dir = await tempDir();
  try {
    const store = await createStore(dir);
    const id = newId();
    const base = { id, input: "mobile note", createdAt: "2026-10-12T01:00:00.000Z", updatedAt: "2026-10-12T01:00:00.000Z", title: "v1" };
    assert.equal(await store.upsertFromSync(base), true);
    assert.equal(await store.upsertFromSync({ ...base, title: "stale", updatedAt: "2026-10-12T00:59:00.000Z" }), false);
    assert.equal(await store.upsertFromSync({ ...base, title: "v2", updatedAt: "2026-10-12T02:00:00.000Z" }), true);
    assert.equal(store.get(id).title, "v2");

    await store.remove(id, "2026-10-12T03:00:00.000Z");
    assert.equal(store.get(id), null);
    // An edit made before the deletion must not resurrect the item.
    assert.equal(await store.upsertFromSync({ ...base, title: "late", updatedAt: "2026-10-12T02:30:00.000Z" }), false);

    const changes = await store.changesSince("");
    assert.deepEqual(changes.deleted.map((entry) => entry.id), [id]);
    assert.equal(changes.items.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("changesSince pages through items with a cursor", async () => {
  const dir = await tempDir();
  try {
    const store = await createStore(dir);
    for (let index = 0; index < 5; index += 1) await store.create({ input: `note ${index}` });
    const first = await store.changesSince("", 2);
    assert.equal(first.items.length, 2);
    assert.equal(first.hasMore, true);
    const second = await store.changesSince(first.cursor, 10);
    assert.equal(second.items.length, 3);
    assert.equal(second.hasMore, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("auth: loopback is local, Tailscale logins honor the allow list, Funnel is refused", () => {
  const req = (headers, remoteAddress = "127.0.0.1") => ({ headers, socket: { remoteAddress }, method: "GET" });
  assert.deepEqual(authorize(req({})), { ok: true, user: "local", via: "loopback" });
  assert.equal(authorize(req({ "tailscale-user-login": "Me@Example.com" })).user, "me@example.com");
  assert.equal(authorize(req({ "tailscale-user-login": "other@example.com" }), ["me@example.com"]).ok, false);
  assert.equal(authorize(req({ "tailscale-funnel-request": "?1" })).ok, false);
  assert.equal(authorize(req({}, "192.168.0.5")).ok, false);
  assert.equal(sameOriginWrite({ method: "POST", headers: { origin: "https://evil.example", host: "me.ts.net" } }), false);
  assert.equal(sameOriginWrite({ method: "POST", headers: { origin: "https://me.ts.net", host: "me.ts.net" } }), true);
});

test("SSRF guard treats private, loopback and Tailscale addresses as private", () => {
  for (const address of ["127.0.0.1", "10.0.0.5", "192.168.1.1", "172.20.0.1", "169.254.1.1", "100.100.1.1", "::1", "fd00::1", "::ffff:10.0.0.1"]) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  assert.equal(isPrivateAddress("8.8.8.8"), false);
});

test("extractPage reads metadata and prefers article text", () => {
  const html = `<html><head><title>Fallback</title><meta property="og:title" content="Real &amp; Title"><meta property="og:image" content="/img.png"></head>
    <body><nav>menu</nav><article><p>${"본문 문장입니다. ".repeat(40)}</p></article><footer>foot</footer><script>bad()</script></body></html>`;
  const page = extractPage(html, "https://example.com/post");
  assert.equal(page.title, "Real & Title");
  assert.equal(page.image, "https://example.com/img.png");
  assert.ok(page.text.includes("본문 문장입니다."));
  assert.ok(!page.text.includes("menu") && !page.text.includes("bad()"));
});

test("parseOrganizeResult survives code fences and cleans fields", () => {
  const answer = 'Here you go:\n```json\n{"title":" 제목 ","summary":"a\\n\\nb","category":"#ai/영상","tags":["#x","x","y","z"]}\n```\nbye';
  const result = parseOrganizeResult(answer, { maxTags: 2 });
  assert.equal(result.title, "제목");
  assert.equal(result.summary, "a\nb");
  assert.equal(result.category, "AI");
  assert.deepEqual(result.tags, ["x", "y"]);
  assert.throws(() => parseOrganizeResult("no json here"));
});

test("organize prompt carries existing categories and treats the clipping as data", () => {
  const { system, user } = buildOrganizePrompts({ input: "memo", url: "https://example.com", categories: ["개발"] });
  assert.match(system, /untrusted data/);
  assert.match(user, /Existing categories: 개발/);
});

test("pushed pending item is organized by the server and returned on pull", async () => {
  const dir = await tempDir();
  const app = await createApp({
    dataDir: dir,
    env: {},
    log: quiet,
    fetchPage: async () => ({ title: "Page", description: "", image: "", siteName: "Site", text: "page text" }),
    createLlm: () => ({ complete: async () => '{"title":"정리된 제목","summary":"요약","category":"AI","tags":["a"]}' }),
  });
  const { port } = await app.listen(0);
  const base = `http://127.0.0.1:${port}`;
  try {
    const id = newId();
    const now = new Date().toISOString();
    const push = await fetch(`${base}/api/sync/push`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: [{ id, input: "https://example.com/post", status: "pending", source: "mobile", createdAt: now, updatedAt: now }], deleted: [] }),
    });
    assert.equal((await push.json()).applied, 1);
    await app.organizer.idle();

    const pull = await (await fetch(`${base}/api/sync/pull`)).json();
    const item = pull.items.find((entry) => entry.id === id);
    assert.equal(item.status, "done");
    assert.equal(item.title, "정리된 제목");
    assert.equal(item.category, "AI");
    assert.equal(item.input, "https://example.com/post");
    assert.equal(item.page, "page text");

    const crossSite = await fetch(`${base}/api/items`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
      body: JSON.stringify({ text: "x" }),
    });
    assert.equal(crossSite.status, 403);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("organizer keeps the item and marks it failed when the LLM is not configured", async () => {
  const dir = await tempDir();
  const app = await createApp({ dataDir: dir, env: {}, log: quiet, fetchPage: async () => { throw new Error("offline"); } });
  try {
    const { item } = await app.store.create({ input: "메모 한 줄\n두번째 줄" });
    app.organizer.enqueue(item.id);
    await app.organizer.idle();
    const after = app.store.get(item.id);
    assert.equal(after.status, "failed");
    assert.equal(after.title, "메모 한 줄");
    assert.match(after.error, /LLM/);
    assert.equal((await app.store.readContent(item.id)).input, "메모 한 줄\n두번째 줄");
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("backlog: items failed for lack of an LLM are retried once it works; other failures are not", async () => {
  const dir = await tempDir();
  let configured = false;
  let answer = '{"title":"T","summary":"S","category":"기타","tags":[]}';
  const app = await createApp({
    dataDir: dir,
    env: {},
    log: quiet,
    fetchPage: async () => {
      throw new Error("offline");
    },
    createLlm: () => {
      if (!configured) throw new Error("설정에서 LLM 제공업체를 선택해 주세요.");
      return { complete: async () => answer };
    },
  });
  try {
    const { item: waiting } = await app.store.create({ input: "저녁에 켜지기 전에 쌓인 메모 1" });
    app.organizer.enqueue(waiting.id);
    await app.organizer.idle();
    assert.equal(app.store.get(waiting.id).status, "failed");

    configured = true;
    answer = "not json";
    const { item: broken } = await app.store.create({ input: "모델이 엉뚱하게 답하는 메모" });
    app.organizer.enqueue(broken.id);
    await app.organizer.idle();
    assert.equal(app.store.get(broken.id).status, "failed");

    answer = '{"title":"T","summary":"S","category":"기타","tags":[]}';
    app.organizer.resume();
    await app.organizer.idle();
    assert.equal(app.store.get(waiting.id).status, "done", "setup failure is retried automatically");
    assert.equal(app.store.get(broken.id).status, "failed", "a bad model answer is not retried on every start");
    assert.deepEqual(app.store.pendingIds(), [], "nothing is left in the queue");
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a queued message keeps the time it was sent, never a future time", async () => {
  const dir = await tempDir();
  try {
    const store = await createStore(dir);
    const past = await store.create({ input: "어제 보낸 메시지", sourceRef: "tg:1:1", createdAt: "2026-10-11T09:00:00.000Z" });
    assert.equal(past.item.createdAt, "2026-10-11T09:00:00.000Z");
    const future = await store.create({ input: "시계가 틀린 메시지", sourceRef: "tg:1:2", createdAt: "2999-01-01T00:00:00.000Z" });
    assert.ok(future.item.createdAt < "2999-01-01");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const goodSubscription = (name) => ({
  endpoint: `https://fcm.googleapis.com/fcm/send/${name}`,
  keys: { p256dh: "BPublicKey", auth: "authSecret" },
});

test("push: only real push services are accepted as endpoints", () => {
  assert.equal(isAllowedEndpoint("https://fcm.googleapis.com/fcm/send/abc"), true);
  assert.equal(isAllowedEndpoint("https://updates.push.services.mozilla.com/wpush/v2/abc"), true);
  assert.equal(isAllowedEndpoint("https://web.push.apple.com/abc"), true);
  assert.equal(isAllowedEndpoint("https://evil.example/fcm.googleapis.com/"), false);
  assert.equal(isAllowedEndpoint("https://fcm.googleapis.com.evil.example/x"), false);
  assert.equal(isAllowedEndpoint("http://fcm.googleapis.com/fcm/send/abc"), false);
  assert.equal(isAllowedEndpoint("https://127.0.0.1:4313/"), false);
});

test("push: keys persist, bad subscriptions are refused, gone devices are dropped", async () => {
  const dir = await tempDir();
  try {
    const calls = [];
    const send = async (subscription, payload) => {
      calls.push({ endpoint: subscription.endpoint, payload: JSON.parse(payload) });
      if (subscription.endpoint.endsWith("/gone")) throw Object.assign(new Error("gone"), { statusCode: 410 });
    };
    const push = await createPush({ dataDir: dir, send, log: quiet });
    assert.equal(await push.subscribe({ endpoint: "https://evil.example/x", keys: { p256dh: "a", auth: "b" } }), false);
    assert.equal(await push.subscribe({ endpoint: goodSubscription("x").endpoint }), false);
    assert.equal(await push.subscribe(goodSubscription("alive"), "me@example.com"), true);
    assert.equal(await push.subscribe(goodSubscription("gone")), true);
    assert.equal(push.count(), 2);

    const result = await push.notifyAll({ type: "online" });
    assert.deepEqual(result, { sent: 1, failed: 1 });
    assert.equal(push.count(), 1, "a 410 response removes the subscription");

    const reopened = await createPush({ dataDir: dir, send, log: quiet });
    assert.equal(reopened.publicKey, push.publicKey, "the VAPID key survives a restart");
    assert.equal(reopened.count(), 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("push: phones are woken when the PC starts and once a backlog has been organized", async () => {
  const dir = await tempDir();
  const sent = [];
  const make = () =>
    createApp({
      dataDir: dir,
      env: {},
      log: quiet,
      pushSend: async (subscription, payload) => {
        sent.push(JSON.parse(payload));
      },
      pushStartDelayMs: 5,
      pushBatchMs: 5,
      fetchPage: async () => {
        throw new Error("offline");
      },
      createLlm: () => ({ complete: async () => '{"title":"T","summary":"S","category":"기타","tags":[]}' }),
    });
  try {
    const first = await make();
    await first.push.subscribe(goodSubscription("phone"));
    await first.close();

    const app = await make();
    await app.listen(0);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.deepEqual(sent.map((entry) => entry.type), ["online"], "announces that the PC is online");

    for (const text of ["밀린 메모 A", "밀린 메모 B", "밀린 메모 C"]) {
      const { item } = await app.store.create({ input: text });
      app.organizer.enqueue(item.id);
    }
    await app.organizer.idle();
    await new Promise((resolve) => setTimeout(resolve, 60));
    const organized = sent.filter((entry) => entry.type === "organized");
    assert.equal(organized.length, 1, "one batched notice, not one per memo");
    assert.equal(organized[0].count, 3);
    await app.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("push API validates subscriptions", async () => {
  const dir = await tempDir();
  const app = await createApp({ dataDir: dir, env: {}, log: quiet, pushSend: async () => {} });
  const { port } = await app.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const post = (route, body) =>
    fetch(`${base}${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  try {
    const key = await (await fetch(`${base}/api/push/key`)).json();
    assert.ok(key.publicKey.length > 40);
    assert.equal((await post("/api/push/subscribe", { subscription: { endpoint: "https://evil.example", keys: { p256dh: "a", auth: "b" } } })).status, 400);
    assert.equal((await post("/api/push/subscribe", { subscription: goodSubscription("ok") })).status, 200);
    assert.equal(app.push.count(), 1);
    await post("/api/push/unsubscribe", { endpoint: goodSubscription("ok").endpoint });
    assert.equal(app.push.count(), 0);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("settings never echo secrets back to the browser", async () => {
  const dir = await tempDir();
  const app = await createApp({ dataDir: dir, env: {}, log: quiet });
  const { port } = await app.listen(0);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ llm: { provider: "anthropic", model: "m", apiKey: "sk-secret" }, telegram: { botToken: "123:abc", allowedChatIds: "11, 22" } }),
    });
    const text = await response.text();
    assert.ok(!text.includes("sk-secret") && !text.includes("123:abc"));
    const body = JSON.parse(text);
    assert.equal(body.settings.llm.hasApiKey, true);
    assert.equal(body.settings.telegram.hasBotToken, true);
    assert.deepEqual(body.settings.telegram.allowedChatIds, ["11", "22"]);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("categories are kept to the broad layout, and old fine-grained names are mapped", async () => {
  const { normalizeCategory } = await import("../shared/taxonomy.mjs");
  assert.equal(normalizeCategory("AI 활용법"), "AI");
  assert.equal(normalizeCategory("게이밍 기어"), "PC");
  assert.equal(normalizeCategory("여행 정보"), "생활");
  assert.equal(normalizeCategory("ComfyUI 노드"), "ComfyUI");
  assert.equal(normalizeCategory("ai/영상"), "AI");
  assert.equal(normalizeCategory("comfyui"), "ComfyUI");
  assert.equal(normalizeCategory("뭔가 새로운 분류"), "기타");
  assert.equal(normalizeCategory(""), "");
  const { system } = buildOrganizePrompts({ input: "x", url: "", page: null });
  assert.match(system, /exactly ONE of these broad categories/);
});

test("an open event stream hears about every stored change", async () => {
  const dir = await tempDir();
  const app = await createApp({ dataDir: dir, env: {}, log: quiet, announceStart: false });
  const controller = new AbortController();
  try {
    const address = await app.listen(0);
    const response = await fetch(`http://127.0.0.1:${address.port}/api/events`, { signal: controller.signal });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/event-stream/);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let received = "";
    const readUntil = async (pattern) => {
      while (!pattern.test(received)) {
        const { value, done } = await reader.read();
        if (done) break;
        received += decoder.decode(value);
      }
    };
    await readUntil(/retry: 3000/);
    await app.store.create({ input: "새 메모" });
    await readUntil(/event: changed/);
    assert.match(received, /event: changed/);
  } finally {
    controller.abort();
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("SNS memos get a sub-folder from the link, other categories are unchanged", async () => {
  const { CATEGORIES, finalizeCategory, normalizeCategory, snsSubcategory } = await import("../shared/taxonomy.mjs");
  assert.deepEqual(CATEGORIES, ["PC", "AI", "ComfyUI", "생활", "영화", "투자", "SNS", "기타"]);
  assert.equal(snsSubcategory("https://www.facebook.com/share/r/1"), "페북");
  assert.equal(snsSubcategory("https://fb.watch/abc"), "페북");
  assert.equal(snsSubcategory("https://www.instagram.com/reel/x"), "인스타");
  assert.equal(snsSubcategory("https://www.threads.com/@a/post/b"), "쓰레드");
  assert.equal(snsSubcategory("https://m.blog.naver.com/a/1"), "블로그");
  assert.equal(snsSubcategory("https://foo.tistory.com/3"), "블로그");
  assert.equal(snsSubcategory("https://x.com/a/status/1"), "ETC");
  assert.equal(snsSubcategory("not a url"), "ETC");
  assert.equal(finalizeCategory("SNS", "https://www.instagram.com/p/x"), "SNS/인스타");
  assert.equal(finalizeCategory("SNS/페북", "https://x.com/a"), "SNS/ETC", "the link decides, not the model");
  assert.equal(finalizeCategory("AI", "https://www.facebook.com/x"), "AI", "a topical post stays in its topic");
  assert.equal(normalizeCategory("SNS/Facebook"), "SNS/페북");
  assert.equal(normalizeCategory("SNS/블러그"), "SNS/블로그");
  assert.equal(normalizeCategory("sns"), "SNS");
  assert.equal(normalizeCategory("영화/드라마"), "영화");
  assert.equal(normalizeCategory("투자"), "투자");
});
