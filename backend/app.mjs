import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { authorize, sameOriginWrite } from "./auth.mjs";
import { fetchPage as defaultFetchPage } from "./fetch-page.mjs";
import { LlmError, PROVIDER_LABELS, createFallbackClient, describeLlm } from "./llm.mjs";
import { createOrganizer } from "./organize.mjs";
import { parseCookies, summarizeCookies } from "./cookies.mjs";
import { createPush } from "./push.mjs";
import { createRenderer } from "./render-page.mjs";
import { SCREEN_BATCH, screenTexts } from "./screen.mjs";
import { createSettings } from "./settings.mjs";
import { createStore } from "./store.mjs";
import { createTelegramBot } from "./telegram.mjs";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
  });
  res.end(text);
}

async function readJson(req, limitBytes) {
  const type = String(req.headers["content-type"] ?? "");
  if (!type.includes("application/json")) throw new HttpError(415, "JSON 요청만 받을 수 있습니다.");
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw new HttpError(413, "요청이 너무 큽니다.");
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (!value || typeof value !== "object") throw new Error("not an object");
    return value;
  } catch {
    throw new HttpError(400, "JSON 형식이 올바르지 않습니다.");
  }
}

async function serveStatic(req, res, webRoot) {
  const url = new URL(req.url, "http://localhost");
  let relative = decodeURIComponent(url.pathname);
  let file = path.resolve(webRoot, `.${relative}`);
  if (file !== webRoot && !file.startsWith(webRoot + path.sep)) throw new HttpError(403, "허용되지 않은 경로입니다.");

  let info = await stat(file).catch(() => null);
  // Unknown extension-less paths belong to the single-page app router.
  if ((!info || info.isDirectory()) && !path.extname(relative)) {
    relative = "/index.html";
    file = path.join(webRoot, "index.html");
    info = await stat(file).catch(() => null);
  }
  if (!info || !info.isFile()) throw new HttpError(404, "찾을 수 없습니다.");

  const immutable = relative.startsWith("/assets/");
  res.writeHead(200, {
    "Content-Type": MIME_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream",
    "Content-Length": info.size,
    "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
  });
  if (req.method === "HEAD") res.end();
  else createReadStream(file).pipe(res);
}

/**
 * Builds the whole backend: storage, settings, organizer, Telegram bot and the HTTP server.
 * Nothing listens until `listen()` is called, so tests can drive it on an ephemeral port.
 */
export async function createApp({
  dataDir,
  vaultDir = "",
  webRoot = null,
  env = process.env,
  fetchPage = defaultFetchPage,
  renderPage,
  createLlm = (config) => createFallbackClient(config),
  pushSend,
  // Wake-up push timing: how long after start-up, and how long to batch "organized" notices.
  pushStartDelayMs = 15_000,
  pushBatchMs = 20_000,
  announceStart = true,
  log = console,
} = {}) {
  const store = await createStore(dataDir, { vaultDir: vaultDir || env.VAULT_DIR || undefined });
  const settings = await createSettings(dataDir, env);
  // Login cookies the user saved in the settings screen. They stay in the private data folder.
  const cookiesFile = path.join(dataDir, "runtime", "cookies.txt");
  async function cookieStatus() {
    try {
      const info = await stat(cookiesFile);
      return { saved: true, savedAt: info.mtime.toISOString(), ...summarizeCookies(parseCookies(await readFile(cookiesFile, "utf8"))) };
    } catch {
      return { saved: false, savedAt: "", count: 0, sites: [] };
    }
  }

  // The headless browser is only wired in for real page downloads; a test that fakes fetchPage stays browser-free.
  const renderer = renderPage === undefined && fetchPage === defaultFetchPage ? createRenderer({ env, log }) : null;
  const render = renderPage ?? (renderer?.available() ? (url, options) => renderer.render(url, { cookiesPath: options?.login ? cookiesFile : "", loginOnly: options?.loginOnly === true }) : null);
  const organizer = createOrganizer({ store, settings, fetchPage, renderPage: render, createLlm, log });
  const bot = createTelegramBot({ store, settings, organizer, log });
  const push = await createPush({ dataDir, subject: env.PUSH_SUBJECT || undefined, send: pushSend, log });
  // Choosing or fixing the LLM in Settings should clear the backlog that failed for lack of one.
  settings.onChange(() => organizer.resume());

  // Tell phones when a backlog finished so their service worker pulls the organized memos, even if
  // the app is closed. Notices are batched so a burst of items produces one notification.
  let organizedTotal = 0;
  let batchTimer = null;
  let startTimer = null;
  organizer.onDrained(({ organized }) => {
    organizedTotal += organized;
    if (!push.count()) return;
    clearTimeout(batchTimer);
    batchTimer = setTimeout(() => {
      const count = organizedTotal;
      organizedTotal = 0;
      push.notifyAll({ type: "organized", count }).catch(() => {});
    }, pushBatchMs);
    batchTimer.unref?.();
  });

  const EVENT_RETRY = "retry: 3000\n\n";
  const EVENT_CHANGED = "event: changed\ndata: {}\n\n";
  const EVENT_PING = ": ping\n\n";

  // Open event streams (one per app window). A change in the store is announced to all of them so a
  // window pulls right away instead of waiting for its next timer tick.
  const eventClients = new Set();
  let changeTimer = null;
  store.onChange(() => {
    if (!eventClients.size || changeTimer) return;
    changeTimer = setTimeout(() => {
      changeTimer = null;
      for (const client of eventClients) client.write(EVENT_CHANGED);
    }, 150);
    changeTimer.unref?.();
  });
  const heartbeat = setInterval(() => {
    for (const client of eventClients) client.write(EVENT_PING);
  }, 25_000);
  heartbeat.unref?.();

  async function route(req, res, user) {
    const url = new URL(req.url, "http://localhost");
    const { pathname } = url;
    const method = req.method ?? "GET";

    if (pathname === "/api/health" && method === "GET") {
      const config = settings.get();
      return sendJson(res, 200, {
        ok: true,
        user,
        serverTime: new Date().toISOString(),
        total: store.stats().total,
        organizer: organizer.status(),
        llm: { provider: config.llm.provider, ...describeLlm(config.llm) },
        telegram: bot.status(),
      });
    }

    if (pathname === "/api/events" && method === "GET") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
      res.write(EVENT_RETRY);
      eventClients.add(res);
      req.on("close", () => eventClients.delete(res));
      return;
    }

    if (pathname === "/api/stats" && method === "GET") return sendJson(res, 200, store.stats());

    if (pathname === "/api/push/key" && method === "GET") {
      return sendJson(res, 200, { publicKey: push.publicKey, subscriptions: push.count() });
    }
    if (pathname === "/api/push/subscribe" && method === "POST") {
      const body = await readJson(req, 16 * 1024);
      if (!(await push.subscribe(body.subscription, user))) throw new HttpError(400, "알림 구독 정보가 올바르지 않습니다.");
      return sendJson(res, 200, { ok: true, subscriptions: push.count() });
    }
    if (pathname === "/api/push/unsubscribe" && method === "POST") {
      const body = await readJson(req, 16 * 1024);
      await push.unsubscribe(String(body.endpoint ?? ""));
      return sendJson(res, 200, { ok: true, subscriptions: push.count() });
    }
    if (pathname === "/api/push/test" && method === "POST") {
      return sendJson(res, 200, await push.notifyAll({ type: "test" }));
    }

    if (pathname === "/api/settings" && method === "GET") {
      const config = settings.get();
      return sendJson(res, 200, { settings: settings.toClient(), llmStatus: describeLlm(config.llm), telegramStatus: bot.status(), storage: { vaultDir: store.vaultPath } });
    }
    if (pathname === "/api/settings" && method === "PUT") {
      await settings.update(await readJson(req, 64 * 1024));
      const config = settings.get();
      return sendJson(res, 200, { settings: settings.toClient(), llmStatus: describeLlm(config.llm), telegramStatus: bot.status(), storage: { vaultDir: store.vaultPath } });
    }

    if (pathname === "/api/llm/test" && method === "POST") {
      try {
        const llm = createLlm(settings.get().llm);
        const sample = await llm.complete("Reply with the single word OK.", "ping");
        const used = llm.lastUsed ? PROVIDER_LABELS[llm.lastUsed] ?? llm.lastUsed : "";
        const switched = llm.lastUsed && llm.lastUsed !== settings.get().llm.provider;
        const note = switched ? ` (선택한 방식이 실패해서 ${used}(으)로 자동 전환됐어요${llm.skipped?.length ? `: ${llm.skipped.join(" / ")}` : ""})` : used ? ` (${used})` : "";
        return sendJson(res, 200, { ok: true, message: `연결되었습니다.${note}`, sample: String(sample).trim().slice(0, 80) });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return sendJson(res, 200, { ok: false, message: error instanceof LlmError ? message : `연결에 실패했습니다: ${message}` });
      }
    }

    if (pathname === "/api/cookies" && method === "GET") return sendJson(res, 200, await cookieStatus());
    if (pathname === "/api/cookies" && method === "PUT") {
      const body = await readJson(req, 8 * 1024 * 1024);
      const text = typeof body.text === "string" ? body.text : "";
      if (!parseCookies(text).length) throw new HttpError(400, "쿠키 파일 형식이 아니거나 유효한 쿠키가 없습니다. 브라우저에서 내보낸 cookies.txt(Netscape 형식)를 골라 주세요.");
      await mkdir(path.dirname(cookiesFile), { recursive: true });
      await writeFile(cookiesFile, text, { mode: 0o600 });
      return sendJson(res, 200, await cookieStatus());
    }
    if (pathname === "/api/cookies" && method === "DELETE") {
      await rm(cookiesFile, { force: true });
      return sendJson(res, 200, await cookieStatus());
    }

    // Import screen: which of these long texts are worth keeping (the rest are everyday notes).
    if (pathname === "/api/import/screen" && method === "POST") {
      const body = await readJson(req, 1024 * 1024);
      const texts = Array.isArray(body.texts) ? body.texts.slice(0, SCREEN_BATCH).map((text) => String(text ?? "")) : [];
      try {
        const keep = await screenTexts(createLlm(settings.get().llm), texts);
        return sendJson(res, 200, { ok: true, keep });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return sendJson(res, 200, { ok: false, message: error instanceof LlmError ? message : `판단에 실패했습니다: ${message}` });
      }
    }

    // Capture endpoint for integrations that do not use the sync protocol (shortcuts, scripts).
    if (pathname === "/api/items" && method === "POST") {
      const body = await readJson(req, 1024 * 1024);
      const input = String(body.text ?? "").trim() || String(body.url ?? "").trim();
      if (!input) throw new HttpError(400, "저장할 내용이 없습니다.");
      const { item, duplicate } = await store.create({ input, url: body.url, title: body.title, source: String(body.source ?? "web") });
      if (!duplicate) organizer.enqueue(item.id);
      return sendJson(res, duplicate ? 200 : 201, { item, duplicate });
    }

    if (pathname === "/api/sync/pull" && method === "GET") {
      const cursor = url.searchParams.get("cursor") ?? "";
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 100));
      return sendJson(res, 200, await store.changesSince(cursor, limit));
    }

    if (pathname === "/api/sync/push" && method === "POST") {
      const body = await readJson(req, 16 * 1024 * 1024);
      const items = Array.isArray(body.items) ? body.items.slice(0, 200) : [];
      const deleted = Array.isArray(body.deleted) ? body.deleted.slice(0, 500) : [];
      let applied = 0;
      for (const raw of items) {
        if (await store.upsertFromSync(raw)) {
          applied += 1;
          if (store.get(raw.id)?.status === "pending") organizer.enqueue(raw.id);
        }
      }
      for (const entry of deleted) {
        if (entry && typeof entry.id === "string") await store.remove(entry.id, entry.deletedAt);
      }
      return sendJson(res, 200, { applied, received: items.length + deleted.length });
    }

    throw new HttpError(404, "존재하지 않는 API입니다.");
  }

  const server = createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    try {
      const access = authorize(req, settings.get().auth.allowedLogins);
      if (!access.ok) throw new HttpError(403, "접근이 허용되지 않았습니다. Tailscale 계정을 확인해 주세요.");
      if (!sameOriginWrite(req)) throw new HttpError(403, "허용되지 않은 출처의 요청입니다.");

      if (req.url?.startsWith("/api/")) return await route(req, res, access.user);
      if (webRoot && (req.method === "GET" || req.method === "HEAD")) return await serveStatic(req, res, webRoot);
      throw new HttpError(404, "찾을 수 없습니다.");
    } catch (error) {
      if (res.headersSent) return res.end();
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) log.error?.(`[http] ${req.method} ${req.url}: ${error.stack ?? error}`);
      sendJson(res, status, { error: status === 500 ? "서버 오류가 발생했습니다." : error.message });
    }
  });

  return {
    server,
    store,
    settings,
    organizer,
    bot,
    push,
    listen(port, host = "127.0.0.1") {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          organizer.resume();
          bot.start();
          // The PC just came online: wake the phones so they hand over whatever piled up.
          if (announceStart && push.count()) {
            startTimer = setTimeout(() => push.notifyAll({ type: "online" }).catch(() => {}), pushStartDelayMs);
            startTimer.unref?.();
          }
          resolve(server.address());
        });
      });
    },
    close() {
      clearTimeout(batchTimer);
      clearTimeout(startTimer);
      clearTimeout(changeTimer);
      clearInterval(heartbeat);
      for (const client of eventClients) client.end();
      eventClients.clear();
      bot.stop();
      void renderer?.close();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
