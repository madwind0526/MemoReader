// Service worker: offline app shell + wake-up pushes. It is built as a single classic script
// (vite.sw.config.ts) and registered from main.tsx. Data never goes through the cache: /api/* always
// hits the network, and the app keeps its own copy of every item in IndexedDB.
import { setMeta } from "./lib/db";
import { OfflineError } from "./lib/serverApi";
import { LAST_PUSH_ERROR_KEY, LAST_PUSH_KEY, LAST_PUSH_SYNC_ERROR_KEY, syncOnce } from "./lib/syncCore";

const sw = self as unknown as ServiceWorkerGlobalScope;

const CACHE = "memoreader-shell-v2";
const STATIC = ["/manifest.webmanifest", "/favicon.svg", "/icons/icon-192.png", "/icons/icon-512.png", "/icons/apple-touch-icon.png"];
const NOTIFICATION_TAG = "memoreader-sync";

// ---- app shell -----------------------------------------------------------------------------

function assetUrls(html: string): string[] {
  return [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((match) => match[1]);
}

// Caches the current build's hashed assets and drops the ones the new index.html no longer uses.
async function refreshShell(cache: Cache, html: string): Promise<void> {
  const wanted = assetUrls(html);
  await Promise.all(wanted.map((url) => cache.add(url).catch(() => {})));
  for (const request of await cache.keys()) {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/assets/") && !wanted.includes(path)) await cache.delete(request);
  }
}

sw.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      const response = await fetch("/", { cache: "reload" });
      await cache.put("/", response.clone());
      await refreshShell(cache, await response.text());
      await Promise.all(STATIC.map((url) => cache.add(url).catch(() => {})));
      await sw.skipWaiting();
    })(),
  );
});

sw.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
      await sw.clients.claim();
    })(),
  );
});

sw.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== sw.location.origin || url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    // Network first so a new build is picked up; the cached shell keeps the app usable offline.
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        try {
          const response = await fetch(request);
          if (response.ok && response.headers.get("content-type")?.includes("text/html")) {
            await cache.put("/", response.clone());
            event.waitUntil(response.clone().text().then((html) => refreshShell(cache, html)));
          }
          return response;
        } catch {
          return (await cache.match("/")) ?? Response.error();
        }
      })(),
    );
    return;
  }

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(request);
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok) await cache.put(request, response.clone());
      return response;
    })(),
  );
});

// ---- wake-up push --------------------------------------------------------------------------

interface PushPayload {
  type?: "online" | "organized" | "test";
  count?: number;
}

function readPayload(event: PushEvent): PushPayload {
  try {
    return (event.data?.json() as PushPayload) ?? {};
  } catch {
    return {};
  }
}

function show(body: string): Promise<void> {
  // One tag, so each new notice replaces the previous one instead of piling up.
  return sw.registration.showNotification("MemoReader", { body, tag: NOTIFICATION_TAG, icon: "/icons/icon-192.png", data: { url: "/" } });
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Waits before each attempt. A phone that was idle may need many seconds to bring its VPN tunnel
// back, so the first connection can be slow. Tests override this through a global.
const RETRY_DELAYS_MS = (globalThis as { MEMOREADER_RETRY_DELAYS?: number[] }).MEMOREADER_RETRY_DELAYS ?? [0, 5000, 15_000, 30_000];

/** Tries the sync a few times and records what went wrong so Settings can show it. */
async function syncWithRetry(): Promise<{ ok: boolean; changed: boolean }> {
  const problems: string[] = [];
  for (const [index, delay] of RETRY_DELAYS_MS.entries()) {
    if (delay) await wait(delay);
    const started = Date.now();
    try {
      const { changed } = await syncOnce({ healthTimeoutMs: 12_000 });
      await setMeta(LAST_PUSH_SYNC_ERROR_KEY, "");
      return { ok: true, changed };
    } catch (error) {
      const seconds = Math.round((Date.now() - started) / 100) / 10;
      const detail = error instanceof OfflineError ? `${error.message} (${error.detail || "원인 불명"})` : error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      problems.push(`${index + 1}번째 시도, ${seconds}초: ${detail}`);
      if (!(error instanceof OfflineError)) break;
    }
  }
  await setMeta(LAST_PUSH_SYNC_ERROR_KEY, problems.join(" / "));
  return { ok: false, changed: false };
}

sw.addEventListener("push", (event) => {
  const payload = readPayload(event);
  event.waitUntil(
    (async () => {
      // Recorded first, so Settings can tell "no push arrived" from "it arrived but could not be shown".
      await setMeta(LAST_PUSH_KEY, new Date().toISOString());
      await setMeta(LAST_PUSH_ERROR_KEY, "");

      // Syncing must not depend on the notification: a blocked notification still hands the memos over.
      const notify = async (body: string) => {
        try {
          await show(body);
        } catch (error) {
          await setMeta(LAST_PUSH_ERROR_KEY, error instanceof Error ? error.message : String(error));
        }
      };

      // A push must always show a notification, so show one first and refine it after syncing.
      await notify(payload.type === "online" ? "PC가 켜졌어요. 쌓인 메모를 동기화하는 중이에요." : "메모를 동기화하는 중이에요.");
      const result = await syncWithRetry();
      if (result.changed) new BroadcastChannel("memoreader").postMessage("changed");

      if (!result.ok) await notify("PC에 연결하지 못했어요. 눌러서 앱을 열면 다시 시도해요.");
      else if (payload.type === "organized" && payload.count) await notify(`메모 ${payload.count}개를 정리했어요. 눌러서 확인하세요.`);
      else if (payload.type === "test") await notify("테스트 알림이에요. 동기화도 확인했어요.");
      else await notify(result.changed ? "새로 정리된 메모를 받았어요." : "동기화했어요.");
    })(),
  );
});

sw.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const windows = await sw.clients.matchAll({ type: "window", includeUncontrolled: true });
      const open = windows[0];
      if (open) await open.focus();
      else await sw.clients.openWindow("/");
    })(),
  );
});
