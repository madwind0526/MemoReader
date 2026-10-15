import type { Item, Tombstone } from "../types";

const DB_NAME = "memoreader";
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        const items = db.createObjectStore("items", { keyPath: "id" });
        items.createIndex("dirty", "dirty");
        db.createObjectStore("tombstones", { keyPath: "id" }).createIndex("dirty", "dirty");
        db.createObjectStore("meta");
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("저장소를 열지 못했습니다."));
    });
    // A failed open must not be cached forever.
    dbPromise.catch(() => {
      dbPromise = null;
    });
  }
  return dbPromise;
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("저장소 작업에 실패했습니다."));
    tx.onabort = () => reject(tx.error ?? new Error("저장소 작업이 중단되었습니다."));
  });
}

function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function getAllItems(): Promise<Item[]> {
  const db = await openDb();
  return result(db.transaction("items").objectStore("items").getAll() as IDBRequest<Item[]>);
}

export async function getItem(id: string): Promise<Item | undefined> {
  const db = await openDb();
  return result(db.transaction("items").objectStore("items").get(id) as IDBRequest<Item | undefined>);
}

export async function getDirtyItems(): Promise<Item[]> {
  const db = await openDb();
  const index = db.transaction("items").objectStore("items").index("dirty");
  return result(index.getAll(IDBKeyRange.only(1)) as IDBRequest<Item[]>);
}

export async function putItems(items: Item[]): Promise<void> {
  if (!items.length) return;
  const db = await openDb();
  const tx = db.transaction("items", "readwrite");
  for (const item of items) tx.objectStore("items").put(item);
  await done(tx);
}

/** Removes an item and records the deletion so other devices learn about it. */
export async function deleteItemWithTombstone(id: string, deletedAt: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(["items", "tombstones"], "readwrite");
  tx.objectStore("items").delete(id);
  tx.objectStore("tombstones").put({ id, deletedAt, dirty: 1 } satisfies Tombstone);
  await done(tx);
}

/** Applies a deletion that came from the server (no need to push it back). */
export async function deleteItemQuietly(id: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction("items", "readwrite");
  tx.objectStore("items").delete(id);
  await done(tx);
}

export async function getTombstones(): Promise<Tombstone[]> {
  const db = await openDb();
  return result(db.transaction("tombstones").objectStore("tombstones").getAll() as IDBRequest<Tombstone[]>);
}

export async function getDirtyTombstones(): Promise<Tombstone[]> {
  const db = await openDb();
  const index = db.transaction("tombstones").objectStore("tombstones").index("dirty");
  return result(index.getAll(IDBKeyRange.only(1)) as IDBRequest<Tombstone[]>);
}

export async function putTombstones(tombstones: Tombstone[]): Promise<void> {
  if (!tombstones.length) return;
  const db = await openDb();
  const tx = db.transaction("tombstones", "readwrite");
  for (const tombstone of tombstones) tx.objectStore("tombstones").put(tombstone);
  await done(tx);
}

export async function getMeta<T>(key: string): Promise<T | undefined> {
  const db = await openDb();
  return result(db.transaction("meta").objectStore("meta").get(key) as IDBRequest<T | undefined>);
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  const db = await openDb();
  const tx = db.transaction("meta", "readwrite");
  tx.objectStore("meta").put(value, key);
  await done(tx);
}
