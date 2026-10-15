// Runs the built service worker (the real bundle) against a real backend, with a fake IndexedDB and
// a fake service-worker scope, to prove a push wakes the phone and the phone syncs while the app is
// closed. Delivery of the push by FCM/Apple/Mozilla is the one part this cannot cover.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

import { IDBFactory, IDBKeyRange } from "fake-indexeddb";

import { createApp } from "../backend/app.mjs";
import { newId } from "../shared/item.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const quiet = { warn() {}, error() {} };

async function buildWorker(outDir) {
  execFileSync(process.execPath, [path.join(ROOT, "node_modules", "vite", "bin", "vite.js"), "build", "--config", "vite.sw.config.ts", "--outDir", outDir], {
    cwd: ROOT,
    stdio: "pipe",
  });
  return readFile(path.join(outDir, "sw.js"), "utf8");
}

/** A minimal service-worker global scope that records notifications and exposes the handlers. */
function createPhone(code, baseUrl) {
  const handlers = new Map();
  const notifications = [];
  const broadcasts = [];
  const indexedDB = new IDBFactory();
  const scope = {
    addEventListener: (type, handler) => handlers.set(type, handler),
    registration: { showNotification: async (title, options) => notifications.push({ title, ...options }) },
    clients: { matchAll: async () => [], openWindow: async () => {}, claim: async () => {} },
    skipWaiting: async () => {},
    location: { origin: baseUrl },
  };
  const sandbox = {
    self: scope,
    indexedDB,
    IDBKeyRange,
    // Relative API paths resolve against the test server, like they do against the page origin.
    fetch: (url, init) => fetch(String(url).startsWith("/") ? baseUrl + url : url, init),
    AbortSignal,
    // Node keeps the process alive for every open BroadcastChannel, which a browser does not.
    BroadcastChannel: class {
      postMessage(message) {
        broadcasts.push(message);
      }
      close() {}
    },
    URL,
    Response,
    caches: { open: async () => ({ match: async () => undefined, put: async () => {}, add: async () => {}, keys: async () => [], delete: async () => {} }), keys: async () => [], delete: async () => {} },
    setTimeout,
    console,
    // Short, so the "PC unreachable" test does not wait out the real retry schedule.
    MEMOREADER_RETRY_DELAYS: [0, 20],
  };
  vm.runInNewContext(code, sandbox);

  return {
    notifications,
    broadcasts,
    indexedDB,
    /** Delivers a push the way the browser does and waits for everything the worker kept alive. */
    async push(payload) {
      const work = [];
      handlers.get("push")({ data: { json: () => payload }, waitUntil: (promise) => work.push(promise) });
      await Promise.all(work);
    },
    async readItems() {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open("memoreader", 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      return new Promise((resolve) => {
        const request = db.transaction("items").objectStore("items").getAll();
        request.onsuccess = () => resolve(request.result);
      });
    },
    async writeItem(item) {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open("memoreader", 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise((resolve, reject) => {
        const tx = db.transaction("items", "readwrite");
        tx.objectStore("items").put(item);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    },
    async readMeta(key) {
      const db = await new Promise((resolve) => {
        const request = indexedDB.open("memoreader", 1);
        request.onsuccess = () => resolve(request.result);
      });
      return new Promise((resolve) => {
        const request = db.transaction("meta").objectStore("meta").get(key);
        request.onsuccess = () => resolve(request.result);
      });
    },
  };
}

test("a push wakes the phone: backlog goes up, organized memos come back, user is told", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "memoreader-sw-"));
  const out = await mkdtemp(path.join(os.tmpdir(), "memoreader-swbuild-"));
  const app = await createApp({
    dataDir: dir,
    env: {},
    log: quiet,
    announceStart: false,
    fetchPage: async () => ({ title: "", description: "", image: "", siteName: "", text: "" }),
    createLlm: () => ({ complete: async () => '{"title":"저녁에 정리됨","summary":"요약","category":"기타","tags":["a"]}' }),
  });
  try {
    const code = await buildWorker(out);
    const { port } = await app.listen(0);
    const phone = createPhone(code, `http://127.0.0.1:${port}`);

    // First wake-up with nothing waiting: creates the local database and finds nothing to do.
    await phone.push({ type: "online" });
    assert.deepEqual(await phone.readItems(), []);
    assert.equal(phone.notifications.at(-1).body, "동기화했어요.");

    // The phone has memos saved while the PC was off (the app is closed, nobody opens it).
    const now = new Date().toISOString();
    const base = { source: "mobile", sourceRef: "", url: "", summary: "", category: "", tags: [], favorite: false, error: "", siteName: "", image: "", page: "", status: "pending", dirty: 1, createdAt: now, updatedAt: now };
    const ids = [newId(), newId()];
    await phone.writeItem({ ...base, id: ids[0], title: "버스 안에서 적은 메모", input: "버스 안에서 적은 메모" });
    await phone.writeItem({ ...base, id: ids[1], title: "점심에 적은 메모", input: "점심에 적은 메모" });

    // The PC comes on and wakes the phone: the backlog is handed over.
    await phone.push({ type: "online" });
    assert.equal(app.store.list().total, 2, "both memos reached the PC");
    assert.ok((await phone.readItems()).every((item) => item.dirty === 0), "nothing is left to upload");
    assert.equal(typeof (await phone.readMeta("lastPushAt")), "string", "the wake-up is recorded for diagnosis");

    // The PC organizes the backlog, then tells the phone it is done.
    await app.organizer.idle();
    assert.equal(app.store.list({ status: "done" }).total, 2, "both memos were organized and the queue is empty");
    assert.deepEqual(app.store.pendingIds(), []);
    await phone.push({ type: "organized", count: 2 });

    const items = await phone.readItems();
    assert.ok(items.every((item) => item.status === "done" && item.title === "저녁에 정리됨"), "the phone holds the final organized content");
    assert.equal(phone.notifications.at(-1).body, "메모 2개를 정리했어요. 눌러서 확인하세요.");
    assert.ok(phone.broadcasts.includes("changed"), "an open app tab is told to refresh");
    assert.ok(phone.notifications.every((entry) => entry.tag === "memoreader-sync"), "notices replace each other instead of piling up");
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
    await rm(out, { recursive: true, force: true });
  }
});

test("when the PC cannot be reached the phone says so and keeps its memos", async () => {
  const out = await mkdtemp(path.join(os.tmpdir(), "memoreader-swbuild-"));
  try {
    const code = await buildWorker(out);
    // Port 9 (discard) refuses connections, standing in for "PC off / VPN not up yet".
    const phone = createPhone(code, "http://127.0.0.1:9");
    const now = new Date().toISOString();
    await phone.push({ type: "test" }); // creates the database
    await phone.writeItem({ id: newId(), status: "pending", source: "mobile", sourceRef: "", url: "", title: "t", summary: "", category: "", tags: [], favorite: false, createdAt: now, updatedAt: now, error: "", siteName: "", image: "", input: "x", page: "", dirty: 1 });
    await phone.push({ type: "online" });
    assert.match(phone.notifications.at(-1).body, /PC에 연결하지 못했어요/);
    const items = await phone.readItems();
    assert.equal(items.length, 1);
    assert.equal(items[0].dirty, 1, "the memo stays queued for the next attempt");
    // The real cause is kept so a phone that cannot reach the PC can show why.
    const why = await phone.readMeta("lastPushSyncError");
    assert.match(why, /1번째 시도/);
    assert.match(why, /2번째 시도/);
    assert.match(why, /TypeError|fetch failed/);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});
