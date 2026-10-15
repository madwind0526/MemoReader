// Reads pages that only show their content after JavaScript runs (single-page apps, link shells) by
// loading them in a real headless browser, then handing the rendered HTML to the same extractor as a
// plain download. The installed Chrome or Edge is used, so nothing has to be downloaded.
import { existsSync } from "node:fs";
import { lookup } from "node:dns/promises";

import { createCookieJar, cookiesForUrl } from "./cookies.mjs";
import { MAX_TEXT_CHARS, assertPublicUrl, extractPage } from "./fetch-page.mjs";

const NAVIGATION_TIMEOUT_MS = 25_000;
const SETTLE_TIMEOUT_MS = 6_000;
const IDLE_CLOSE_MS = 120_000;
const BLOCKED_RESOURCES = new Set(["image", "media", "font"]);
// Opening many pages of one site with a logged-in session can look like a bot; keep a pause between them.
// The pause is a fixed part plus a random part, so the rhythm does not look machine-made.
const LOGGED_IN_GAP_MS = 10_000;
const LOGGED_IN_JITTER_MS = 6_000;

// The usual install locations; BROWSER_PATH overrides them.
const BROWSER_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];

/** Path of a Chrome/Edge to drive, or "" when none is installed. */
export function findBrowser(env = process.env, exists = existsSync) {
  const configured = env.BROWSER_PATH?.trim();
  if (configured) return exists(configured) ? configured : "";
  return BROWSER_CANDIDATES.find((candidate) => exists(candidate)) ?? "";
}

/** Page text that is only an "enable JavaScript" notice or too little to organize from. */
export const THIN_TEXT_CHARS = 300;
const SCRIPT_NOTICE = /enable javascript|turn on javascript|javascript (is )?(required|disabled)|requires javascript|자바스크립트(를)? (활성|사용|켜)|JavaScript를 (활성|사용)/i;

/** Whether a plain download got too little to work with, so a rendered load is worth trying. */
export function needsRender(fetched) {
  if (!fetched) return true;
  const text = fetched.text ?? "";
  return text.length < THIN_TEXT_CHARS || (SCRIPT_NOTICE.test(text) && text.length < 1500);
}

/**
 * A renderer that starts one shared browser on first use and closes it again after a quiet period.
 * `launch` is injectable so tests can run without a real browser.
 */
export function createRenderer({ env = process.env, launch, lookupImpl = lookup, log = console, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = Date.now } = {}) {
  const loadCookies = createCookieJar();
  const nextLoggedIn = new Map(); // site -> earliest time the next logged-in page of it may be opened
  let browserPromise = null;
  let idleTimer = null;
  let chain = Promise.resolve(); // one page at a time: the organizer is serial and a browser is heavy

  async function start() {
    const executablePath = findBrowser(env);
    if (!executablePath) throw new Error("Chrome 또는 Edge를 찾지 못했습니다. 환경 변수 BROWSER_PATH로 위치를 알려 주세요.");
    const open = launch ?? (await import("puppeteer-core")).default.launch;
    return open({ executablePath, headless: true, args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--mute-audio"] });
  }

  async function closeBrowser() {
    const current = browserPromise;
    browserPromise = null;
    clearTimeout(idleTimer);
    if (current) await (await current.catch(() => null))?.close().catch(() => {});
  }

  async function renderOnce(rawUrl, { cookiesPath = "", loginOnly = false } = {}) {
    await assertPublicUrl(rawUrl, lookupImpl);
    // `loginOnly`: this call only makes sense with a saved login for the site; without one there is nothing to do.
    if (loginOnly && !cookiesForUrl(await loadCookies(cookiesPath), rawUrl).length) return null;
    browserPromise ??= start();
    let browser;
    try {
      browser = await browserPromise;
    } catch (error) {
      browserPromise = null;
      throw error;
    }
    clearTimeout(idleTimer);
    const page = await browser.newPage();
    let applied = [];
    try {
      await page.setViewport({ width: 1280, height: 900 });
      await page.setUserAgent((await browser.userAgent()).replace("HeadlessChrome", "Chrome"));
      await page.setExtraHTTPHeaders({ "Accept-Language": "ko,en;q=0.8" });
      // Every request the page makes (redirects, scripts, XHR) is checked like the first one, so a page
      // cannot make the server reach into the local network; pictures, video and fonts are skipped for speed.
      const verdicts = new Map();
      await page.setRequestInterception(true);
      page.on("request", (request) => {
        if (BLOCKED_RESOURCES.has(request.resourceType())) return void request.abort();
        const address = request.url();
        if (!/^https?:/i.test(address)) return void request.continue();
        let host;
        try {
          host = new URL(address).hostname;
        } catch {
          return void request.abort();
        }
        if (!verdicts.has(host)) verdicts.set(host, assertPublicUrl(address, lookupImpl).then(() => true, () => false));
        verdicts.get(host).then((allowed) => (allowed ? request.continue() : request.abort()), () => request.abort());
      });
      // Logged-in reading (opt-in): only the cookies of the page's own site go in, and they come out again afterwards.
      applied = cookiesForUrl(await loadCookies(cookiesPath), rawUrl);
      if (applied.length) {
        const site = new URL(rawUrl).hostname.split(".").slice(-2).join(".");
        const pause = (nextLoggedIn.get(site) ?? 0) - now();
        if (pause > 0) await wait(pause);
        nextLoggedIn.set(site, now() + LOGGED_IN_GAP_MS + Math.random() * LOGGED_IN_JITTER_MS);
        await page.setCookie(...applied);
      }
      await page.goto(rawUrl, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
      // Most pages are still filling in after the first load; wait for the network to go quiet (bounded).
      await page.waitForNetworkIdle({ idleTime: 800, timeout: SETTLE_TIMEOUT_MS }).catch(() => {});
      const html = await page.content();
      const finalUrl = page.url() || rawUrl;
      return { finalUrl, ...extractPage(html, finalUrl) };
    } finally {
      if (applied.length) await page.deleteCookie(...applied.map(({ name, domain, path }) => ({ name, domain, path }))).catch(() => {});
      await page.close().catch(() => {});
      idleTimer = setTimeout(() => void closeBrowser(), IDLE_CLOSE_MS);
      idleTimer.unref?.();
    }
  }

  return {
    available: () => Boolean(findBrowser(env)),
    /** The rendered page in the same shape fetchPage returns. Calls run one after another. */
    render(rawUrl, options = {}) {
      const run = chain.then(() => renderOnce(rawUrl, options));
      chain = run.catch((error) => {
        log.warn?.(`[render] ${rawUrl.slice(0, 80)}: ${error.message}`);
      });
      return run;
    },
    close: closeBrowser,
  };
}

export { MAX_TEXT_CHARS };
