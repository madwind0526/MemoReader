// Reading JavaScript-only pages with a headless browser: tested against a fake browser, no Chrome is started.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createApp } from "../backend/app.mjs";
import { createRenderer, findBrowser, needsRender } from "../backend/render-page.mjs";

const quiet = { warn() {}, error() {}, info() {} };
const PUBLIC = async () => [{ address: "93.184.216.34", family: 4 }];

test("a browser is found from BROWSER_PATH or the usual install places", () => {
  assert.equal(findBrowser({ BROWSER_PATH: "D:\\b\\chrome.exe" }, () => true), "D:\\b\\chrome.exe");
  assert.equal(findBrowser({ BROWSER_PATH: "D:\\missing.exe" }, () => false), "");
  assert.match(findBrowser({}, (candidate) => /msedge\.exe$/.test(candidate)), /msedge\.exe$/);
  assert.equal(findBrowser({}, () => false), "");
});

test("only a stub of a page is worth reading with the browser", () => {
  assert.equal(needsRender(null), true);
  assert.equal(needsRender({ text: "Facebook" }), true);
  assert.equal(needsRender({ text: "You need to enable JavaScript to run this app. ".repeat(3) }), true);
  assert.equal(needsRender({ text: "긴 본문 ".repeat(200) }), false);
  assert.equal(needsRender({ text: "a real article that mentions enable javascript once. ".repeat(60) }), false);
});

/** A stand-in for a puppeteer browser: records what happens and lets a test fire page requests. */
function fakeBrowser({ html, finalUrl }) {
  const log = { aborted: [], continued: [], closedPages: 0, launched: 0, browserClosed: false };
  const page = {
    handlers: {},
    setViewport: async () => {},
    setUserAgent: async () => {},
    setExtraHTTPHeaders: async () => {},
    setRequestInterception: async () => {},
    on(event, handler) {
      this.handlers[event] = handler;
    },
    goto: async () => {},
    waitForNetworkIdle: async () => {},
    content: async () => html,
    url: () => finalUrl,
    close: async () => {
      log.closedPages += 1;
    },
  };
  const browser = { userAgent: async () => "Mozilla/5.0 HeadlessChrome/140", newPage: async () => page, close: async () => { log.browserClosed = true; } };
  const launch = async () => {
    log.launched += 1;
    return browser;
  };
  const fire = (url, resourceType = "xhr") =>
    new Promise((resolve) => {
      page.handlers.request({ url: () => url, resourceType: () => resourceType, abort: () => resolve("abort"), continue: () => resolve("continue") });
    });
  return { launch, log, page, fire };
}

const ENV = { BROWSER_PATH: process.execPath }; // any existing file stands in for the browser

test("the rendered HTML goes through the same extractor as a plain download", async () => {
  const html = `<html><head><title>앱</title><meta property="og:title" content="렌더된 제목"><meta property="article:published_time" content="2026-09-01"></head><body><main>${"렌더링 뒤에 나타난 본문. ".repeat(40)}</main></body></html>`;
  const browser = fakeBrowser({ html, finalUrl: "https://example.com/final" });
  const renderer = createRenderer({ env: ENV, launch: browser.launch, lookupImpl: PUBLIC, log: quiet });
  const page = await renderer.render("https://example.com/app");
  assert.equal(page.title, "렌더된 제목");
  assert.equal(page.finalUrl, "https://example.com/final");
  assert.equal(page.publishedAt, "2026-09-01");
  assert.match(page.text, /렌더링 뒤에 나타난 본문/);
  assert.equal(browser.log.closedPages, 1);
  await renderer.render("https://example.com/again");
  assert.equal(browser.log.launched, 1, "the browser is started once and reused");
  await renderer.close();
  assert.equal(browser.log.browserClosed, true);
});

test("requests into the local network are blocked, public ones and pictures are handled", async () => {
  const browser = fakeBrowser({ html: "<body>x</body>", finalUrl: "https://example.com/" });
  const lookupImpl = async (host) => (host === "internal.test" ? [{ address: "10.0.0.5", family: 4 }] : PUBLIC());
  const renderer = createRenderer({ env: ENV, launch: browser.launch, lookupImpl, log: quiet });
  await renderer.render("https://example.com/");
  assert.equal(await browser.fire("https://example.com/api"), "continue");
  assert.equal(await browser.fire("http://127.0.0.1:4313/api/settings"), "abort");
  assert.equal(await browser.fire("http://internal.test/secret"), "abort");
  assert.equal(await browser.fire("https://example.com/a.png", "image"), "abort");
  await assert.rejects(renderer.render("http://192.168.0.1/admin"), /사설|내부|허용|공개/);
  await renderer.close();
});

test("without an installed browser rendering says so instead of crashing", async () => {
  const renderer = createRenderer({ env: { BROWSER_PATH: "Z:\\nowhere.exe" }, lookupImpl: PUBLIC, log: quiet });
  assert.equal(renderer.available(), false);
  await assert.rejects(renderer.render("https://example.com/"), /Chrome 또는 Edge/);
});

async function organizeWith({ fetched, fetchError, rendered, loginRendered = null, organize }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "memoreader-render-"));
  const calls = { render: 0, loginRender: 0 };
  const seen = { page: "" };
  const app = await createApp({
    dataDir: dir,
    env: {},
    log: quiet,
    fetchPage: async () => {
      if (fetchError) throw new Error(fetchError);
      return { title: "", description: "", image: "", siteName: "", publishedAt: "", images: [], text: fetched };
    },
    renderPage: async (_url, options) => {
      if (options?.loginOnly) {
        // The retry with the saved login: null stands for "no login saved for this site".
        calls.loginRender += 1;
        return loginRendered === null ? null : { title: "", description: "", image: "", siteName: "로그인", publishedAt: "", images: [], text: loginRendered };
      }
      calls.render += 1;
      return { title: "", description: "", image: "", siteName: "렌더", publishedAt: "", images: [], text: rendered };
    },
    createLlm: () => ({
      complete: async (_system, user) => {
        seen.page = user;
        return '{"title":"제목","summary":"요약","category":"AI","tags":["a"]}';
      },
    }),
  });
  if (organize) await app.settings.update({ organize });
  try {
    const { item } = await app.store.create({ input: "https://example.com/post", url: "https://example.com/post" });
    app.organizer.enqueue(item.id);
    await app.organizer.idle();
    return { calls, seen, content: await app.store.readContent(item.id), meta: app.store.get(item.id) };
  } finally {
    await app.close?.();
    await rm(dir, { recursive: true, force: true });
  }
}

test("a thin download is replaced by what the browser read", async () => {
  const body = "브라우저가 읽은 긴 본문입니다. ".repeat(40);
  const result = await organizeWith({ fetched: "Facebook", rendered: body });
  assert.equal(result.calls.render, 1);
  assert.equal(result.content.page, body.slice(0, result.content.page.length));
  assert.ok(result.content.page.length > 300);
  assert.equal(result.meta.status, "done");
});

test("a good download is not rendered, a blocked or empty one is, and 404 is not", async () => {
  const good = "충분히 긴 일반 본문입니다. ".repeat(40);
  assert.equal((await organizeWith({ fetched: good, rendered: "x".repeat(900) })).calls.render, 0);
  const blocked = await organizeWith({ fetchError: "페이지를 가져오지 못했습니다 (HTTP 403).", rendered: "브라우저는 볼 수 있는 본문. ".repeat(40) });
  assert.equal(blocked.calls.render, 1);
  assert.match(blocked.content.page, /브라우저는 볼 수 있는 본문/);
  const gone = await organizeWith({ fetchError: "페이지를 가져오지 못했습니다 (HTTP 404).", rendered: "x".repeat(900) });
  assert.equal(gone.calls.render, 0);
});

test("the browser can be switched off in the settings", async () => {
  const off = await organizeWith({ fetched: "Facebook", rendered: "x".repeat(900), organize: { render: false } });
  assert.equal(off.calls.render, 0);
});

test("when the browser reads no more than the download, the download is kept", async () => {
  const result = await organizeWith({ fetched: "짧은 본문 " + "가".repeat(100), rendered: "더 짧음" });
  assert.equal(result.calls.render, 1);
  assert.match(result.content.page, /^짧은 본문/);
});

test("a login wall is read again with the saved login, only when one is saved", async () => {
  const body = "로그인한 상태에서 읽은 긴 본문입니다. ".repeat(40);
  const withLogin = await organizeWith({ fetched: "Facebook", rendered: "로그인 필요", loginRendered: body });
  assert.equal(withLogin.calls.render, 1);
  assert.equal(withLogin.calls.loginRender, 1);
  assert.match(withLogin.content.page, /로그인한 상태에서 읽은/);
  const withoutLogin = await organizeWith({ fetched: "Facebook", rendered: "로그인 필요" });
  assert.equal(withoutLogin.calls.loginRender, 1, "asked once, answered with nothing");
  assert.doesNotMatch(withoutLogin.content.page, /로그인한 상태/);
  const readable = await organizeWith({ fetched: "Facebook", rendered: "충분히 긴 본문. ".repeat(60), loginRendered: body });
  assert.equal(readable.calls.loginRender, 0, "a page that read fine never asks for the login");
  const always = await organizeWith({ fetched: "Facebook", rendered: "로그인 필요", loginRendered: body, organize: { useLogin: true } });
  assert.equal(always.calls.loginRender, 0, "with the login always on there is no second read");
});
