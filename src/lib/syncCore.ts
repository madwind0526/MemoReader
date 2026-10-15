// Sync logic with no UI or window dependencies, shared by the page (sync.ts) and the service
// worker (sw.ts), which wakes up on a push while the app is closed.
import type { Item, Tombstone } from "../types";
import {
  deleteItemQuietly,
  getDirtyItems,
  getDirtyTombstones,
  getItem,
  getMeta,
  getTombstones,
  putItems,
  putTombstones,
  setMeta,
} from "./db";
import { api } from "./serverApi";

export interface Health {
  ok: boolean;
  user: string;
  organizer: { queued: number; running: boolean };
  llm: { ready: boolean; message: string };
}

interface PullResponse {
  items: Array<Omit<Item, "dirty">>;
  deleted: Array<{ id: string; deletedAt: string }>;
  cursor: string;
  hasMore: boolean;
}

export const CURSOR_KEY = "syncCursor";
export const LAST_SYNC_KEY = "lastSyncAt";
/** Written by the service worker whenever a wake-up push arrives; shown in Settings for diagnosis. */
export const LAST_PUSH_KEY = "lastPushAt";
/** Why the last wake-up could not show its notification (empty when it could). */
export const LAST_PUSH_ERROR_KEY = "lastPushError";
/** What went wrong in the last wake-up sync attempts (empty when it worked). */
export const LAST_PUSH_SYNC_ERROR_KEY = "lastPushSyncError";
const PUSH_BATCH = 20;

function stripDirty(item: Item): Omit<Item, "dirty"> {
  const { dirty: _dirty, ...rest } = item;
  void _dirty;
  return rest;
}

async function pushLocalChanges(): Promise<void> {
  for (;;) {
    const dirtyItems = (await getDirtyItems()).slice(0, PUSH_BATCH);
    const dirtyTombstones = (await getDirtyTombstones()).slice(0, 100);
    if (!dirtyItems.length && !dirtyTombstones.length) return;

    await api("/api/sync/push", {
      method: "POST",
      body: { items: dirtyItems.map(stripDirty), deleted: dirtyTombstones.map(({ id, deletedAt }) => ({ id, deletedAt })) },
      timeoutMs: 30_000,
    });

    // Clear the flag only when the item was not edited again while the request was in flight.
    const settled: Item[] = [];
    for (const sent of dirtyItems) {
      const current = await getItem(sent.id);
      if (current && current.updatedAt === sent.updatedAt) settled.push({ ...current, dirty: 0 });
    }
    await putItems(settled);
    await putTombstones(dirtyTombstones.map((tombstone): Tombstone => ({ ...tombstone, dirty: 0 })));
  }
}

async function pullServerChanges(): Promise<boolean> {
  let cursor = (await getMeta<string>(CURSOR_KEY)) ?? "";
  const tombstones = new Map((await getTombstones()).map((entry) => [entry.id, entry.deletedAt]));
  let changed = false;

  for (;;) {
    const page = await api<PullResponse>(`/api/sync/pull?cursor=${encodeURIComponent(cursor)}&limit=100`, { timeoutMs: 30_000 });
    const writes: Item[] = [];
    for (const remote of page.items) {
      const local = await getItem(remote.id);
      if (local && local.updatedAt >= remote.updatedAt) continue;
      const deletedAt = tombstones.get(remote.id);
      if (deletedAt && deletedAt >= remote.updatedAt) continue;
      writes.push({ ...remote, dirty: 0 });
    }
    for (const entry of page.deleted) {
      const local = await getItem(entry.id);
      if (local && local.updatedAt <= entry.deletedAt) {
        await deleteItemQuietly(entry.id);
        changed = true;
      }
    }
    await putItems(writes);
    if (writes.length) changed = true;
    cursor = page.cursor;
    await setMeta(CURSOR_KEY, cursor);
    if (!page.hasMore) return changed;
  }
}

/**
 * One full round: check the PC is reachable, upload local changes, download the server's.
 * Throws OfflineError when the PC cannot be reached and ApiError when it refuses.
 */
export async function syncOnce(options: { healthTimeoutMs?: number } = {}): Promise<{ health: Health; changed: boolean; lastSyncAt: string }> {
  const health = await api<Health>("/api/health", { timeoutMs: options.healthTimeoutMs ?? 4000 });
  await pushLocalChanges();
  const changed = await pullServerChanges();
  const lastSyncAt = new Date().toISOString();
  await setMeta(LAST_SYNC_KEY, lastSyncAt);
  return { health, changed, lastSyncAt };
}
