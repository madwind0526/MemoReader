// Logged-in reading: a cookies.txt export is parsed, only the page's own site gets its cookies, and they are removed again.
import assert from "node:assert/strict";
import test from "node:test";

import { cookiesForUrl, createCookieJar, parseCookies } from "../backend/cookies.mjs";
import { createRenderer } from "../backend/render-page.mjs";

const NOW = 1_800_000_000; // seconds
const FILE = [
  "# Netscape HTTP Cookie File",
  ".facebook.com\tTRUE\t/\tTRUE\t1900000000\tc_user\t12345",
  "#HttpOnly_.facebook.com\tTRUE\t/\tTRUE\t1900000000\txs\tsecret-token",
  ".facebook.com\tTRUE\t/\tTRUE\t1700000000\told\texpired",
  "www.instagram.com\tFALSE\t/\tTRUE\t0\tsessionid\tabc",
  ".reddit.com\tTRUE\t/\tTRUE\t1900000000\treddit_session\tr1",
  "broken line without tabs",
  "",
].join("\n");

test("a cookies.txt export is parsed; expired and broken lines are dropped", () => {
  const cookies = parseCookies(FILE, NOW);
  assert.deepEqual(cookies.map((cookie) => cookie.name), ["c_user", "xs", "sessionid", "reddit_session"]);
  const xs = cookies.find((cookie) => cookie.name === "xs");
  assert.equal(xs.httpOnly, true);
  assert.equal(xs.secure, true);
  assert.equal(xs.value, "secret-token");
  assert.equal(cookies.find((cookie) => cookie.name === "sessionid").expires, undefined, "a session cookie has no expiry");
});

test("a page only gets the cookies of its own site", () => {
  const cookies = parseCookies(FILE, NOW);
  assert.deepEqual(cookiesForUrl(cookies, "https://m.facebook.com/share/r/abc").map((cookie) => cookie.name), ["c_user", "xs"]);
  assert.deepEqual(cookiesForUrl(cookies, "https://www.instagram.com/p/xyz/").map((cookie) => cookie.name), ["sessionid"]);
  assert.deepEqual(cookiesForUrl(cookies, "https://instagram.com/p/xyz/"), [], "a cookie set for www. is not sent to the bare domain");
  assert.deepEqual(cookiesForUrl(cookies, "https://evil-facebook.com/"), []);
  assert.deepEqual(cookiesForUrl(cookies, "not a url"), []);
});

test("the cookie file is read again only when it changes, and a missing file is no cookies", async () => {
  let reads = 0;
  let stamp = 1;
  const load = createCookieJar({ readImpl: async () => { reads += 1; return FILE; }, statImpl: async () => ({ mtimeMs: stamp }) });
  assert.equal((await load("C:\c.txt")).length > 0, true);
  await load("C:\c.txt");
  assert.equal(reads, 1);
  stamp = 2;
  await load("C:\c.txt");
  assert.equal(reads, 2);
  assert.deepEqual(await load(""), []);
  const missing = createCookieJar({ statImpl: async () => { throw new Error("ENOENT"); } });
  assert.deepEqual(await missing("C:\none.txt"), []);
});

function fakeBrowser() {
  const calls = { set: [], deleted: [], gotos: [] };
  const page = {
    on() {},
    setViewport: async () => {},
    setUserAgent: async () => {},
    setExtraHTTPHeaders: async () => {},
    setRequestInterception: async () => {},
    setCookie: async (...cookies) => void calls.set.push(cookies.map((cookie) => cookie.name)),
    deleteCookie: async (...cookies) => void calls.deleted.push(cookies.map((cookie) => cookie.name)),
    goto: async (url) => void calls.gotos.push(url),
    waitForNetworkIdle: async () => {},
    content: async () => "<body>x</body>",
    url: () => "https://www.facebook.com/",
    close: async () => {},
  };
  return { calls, launch: async () => ({ userAgent: async () => "HeadlessChrome", newPage: async () => page, close: async () => {} }) };
}

test("logged-in pages get their cookies, a pause between pages of one site, and the cookies are removed afterwards", async () => {
  const dir = await import("node:fs/promises").then((fs) => fs.mkdtemp(`${process.env.TEMP ?? "/tmp"}/mr-cookies-`));
  const file = `${dir}/cookies.txt`;
  await import("node:fs/promises").then((fs) => fs.writeFile(file, FILE.replaceAll("1900000000", String(Math.floor(Date.now() / 1000) + 1e7))));
  const browser = fakeBrowser();
  const waits = [];
  let clock = 1_000_000;
  const renderer = createRenderer({
    env: { BROWSER_PATH: process.execPath },
    launch: browser.launch,
    lookupImpl: async () => [{ address: "93.184.216.34", family: 4 }],
    log: { warn() {} },
    wait: async (ms) => { waits.push(ms); clock += ms; },
    now: () => clock,
  });
  await renderer.render("https://www.facebook.com/a", { cookiesPath: file });
  await renderer.render("https://www.facebook.com/b", { cookiesPath: file });
  await renderer.render("https://www.reddit.com/r/x", { cookiesPath: file });
  await renderer.render("https://example.com/", { cookiesPath: file });
  await renderer.render("https://www.facebook.com/c"); // no cookie file: logged out
  assert.deepEqual(browser.calls.set, [["c_user", "xs"], ["c_user", "xs"], ["reddit_session"]]);
  assert.deepEqual(browser.calls.deleted, browser.calls.set, "every cookie that went in comes out again");
  assert.equal(waits.length, 1, "only the second Facebook page had to wait");
  assert.ok(waits[0] >= 10_000 && waits[0] <= 16_000, "10 s plus up to 6 s of random jitter");
  await renderer.close();
});

import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createApp } from "../backend/app.mjs";
import { summarizeCookies } from "../backend/cookies.mjs";

test("a cookie summary names the sites with a saved login and never shows a value", () => {
  const summary = summarizeCookies(parseCookies(FILE, NOW));
  assert.deepEqual(summary, { count: 4, sites: ["facebook.com", "instagram.com", "reddit.com"] });
  assert.equal(JSON.stringify(summary).includes("secret-token"), false);
  assert.deepEqual(summarizeCookies([{ name: "NID_SES", domain: ".naver.co.kr" }]).sites, ["naver.co.kr"]);
});

test("the settings screen can save, inspect and delete the cookie file", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "memoreader-cookies-"));
  const app = await createApp({ dataDir: dir, env: {}, log: { warn() {}, error() {}, info() {} }, fetchPage: async () => ({}) , renderPage: null });
  const { port } = await app.listen(0);
  const url = `http://127.0.0.1:${port}/api/cookies`;
  const send = (method, body) => fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  try {
    assert.deepEqual(await (await send("GET")).json(), { saved: false, savedAt: "", count: 0, sites: [] });
    assert.equal((await send("PUT", { text: "not a cookie file" })).status, 400);
    const future = Math.floor(Date.now() / 1000) + 1e7;
    const text = `.facebook.com\tTRUE\t/\tTRUE\t${future}\tc_user\t999\n#HttpOnly_.facebook.com\tTRUE\t/\tTRUE\t${future}\txs\ttop-secret\n`;
    const saved = await (await send("PUT", { text })).json();
    assert.equal(saved.saved, true);
    assert.equal(saved.count, 2);
    assert.deepEqual(saved.sites, ["facebook.com"]);
    assert.equal(JSON.stringify(saved).includes("top-secret"), false, "no cookie value is ever sent back");
    assert.equal(await readFile(path.join(dir, "runtime", "cookies.txt"), "utf8"), text);
    assert.equal((await (await send("DELETE")).json()).saved, false);
  } finally {
    await app.close?.();
    await rm(dir, { recursive: true, force: true });
  }
});

test("the organizer asks for a logged-in read only when the setting is on", async () => {
  const seen = [];
  const dir = await mkdtemp(path.join(os.tmpdir(), "memoreader-login-"));
  const app = await createApp({
    dataDir: dir,
    env: {},
    log: { warn() {}, error() {}, info() {} },
    fetchPage: async () => ({ title: "", description: "", image: "", siteName: "", publishedAt: "", images: [], text: "Facebook" }),
    renderPage: async (_url, options) => {
      seen.push(options.login);
      return { title: "", description: "", image: "", siteName: "", publishedAt: "", images: [], text: "읽은 본문 ".repeat(80) };
    },
    createLlm: () => ({ complete: async () => '{"title":"제목","summary":"요약","category":"AI","tags":["a"]}' }),
  });
  try {
    for (const useLogin of [false, true]) {
      await app.settings.update({ organize: { useLogin } });
      const { item } = await app.store.create({ input: `https://example.com/${useLogin}`, url: `https://example.com/${useLogin}` });
      app.organizer.enqueue(item.id);
      await app.organizer.idle();
    }
    assert.deepEqual(seen, [false, true]);
  } finally {
    await app.close?.();
    await rm(dir, { recursive: true, force: true });
  }
});
