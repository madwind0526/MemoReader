import { useSyncExternalStore } from "react";

import { extractFirstUrl, fallbackTitle, mergeInput, newId, normalizeUrl } from "../../shared/item.mjs";
import type { Item } from "../types";
import { deleteItemWithTombstone, getAllItems, getItem, putItems } from "./db";
import { requestSync, setOnRemoteChange } from "./sync";

interface LibraryState {
  items: Item[];
  loaded: boolean;
  error: string;
}

let state: LibraryState = { items: [], loaded: false, error: "" };
const listeners = new Set<() => void>();
const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("memoreader");

function emit() {
  for (const listener of listeners) listener();
}

export async function reload(): Promise<void> {
  try {
    const items = await getAllItems();
    items.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    state = { items, loaded: true, error: "" };
  } catch (error) {
    state = { ...state, loaded: true, error: error instanceof Error ? error.message : "저장소를 사용할 수 없습니다." };
  }
  emit();
}

// Other tabs of this app write to the same database; refresh when they tell us they did.
channel?.addEventListener("message", () => void reload());
setOnRemoteChange(() => {
  channel?.postMessage("changed");
  void reload();
});
void reload();

export function useLibrary(): LibraryState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
  );
}

function afterLocalChange() {
  channel?.postMessage("changed");
  void reload();
  requestSync();
}

/** Never lets an edit sort before the version it replaces, even if the device clock is behind. */
function nextStamp(previous: string): string {
  const now = new Date().toISOString();
  return now > previous ? now : new Date(Date.parse(previous) + 1).toISOString();
}

export function deviceSource(): string {
  return window.matchMedia("(pointer: coarse)").matches ? "mobile" : "pc";
}

export interface AddInput {
  text: string;
  url?: string;
  title?: string;
  source?: string;
}

export async function addItem(input: AddInput): Promise<{ item: Item; duplicate: boolean; merged: boolean }> {
  const text = input.text.trim();
  const link = normalizeUrl(input.url ?? "") || extractFirstUrl(text);
  if (link) {
    const existing = state.items.find((item) => item.url === link);
    if (existing) {
      // Saving a link again keeps the item and adds whatever new words came with it.
      const combined = mergeInput(existing.input, text);
      const merged = combined !== existing.input;
      if (merged) {
        await putItems([{ ...existing, input: combined, updatedAt: nextStamp(existing.updatedAt), dirty: 1 }]);
        afterLocalChange();
      }
      return { item: existing, duplicate: true, merged };
    }
  }
  const now = new Date().toISOString();
  const item: Item = {
    id: newId(),
    status: "pending",
    source: input.source ?? deviceSource(),
    sourceRef: "",
    url: link,
    title: input.title?.trim() || fallbackTitle({ pageTitle: "", input: text, url: link }),
    summary: "",
    category: "",
    tags: [],
    favorite: false,
    createdAt: now,
    updatedAt: now,
    error: "",
    siteName: "",
    image: "",
    video: "",
    images: [],
    input: text,
    page: "",
    dirty: 1,
  };
  await putItems([item]);
  afterLocalChange();
  return { item, duplicate: false, merged: false };
}

export interface ImportEntry {
  text: string;
  /** When the message was written; becomes the memo's save time. */
  at: Date;
  sourceRef: string;
  /** A title the file already has (a blog post's headline); the organizer still writes the final one. */
  title?: string;
  /** Overrides the link taken from the text. "" means no link: a long article must not be replaced by the first address inside it. */
  url?: string;
}

/**
 * Saves many imported messages at once. A link that already exists (or repeats inside the batch) keeps one
 * memo and gets the extra words appended; everything else becomes a pending memo for the PC to organize.
 */
export async function importItems(entries: ImportEntry[], source = "kakao"): Promise<{ created: number; merged: number }> {
  const byUrl = new Map(state.items.filter((item) => item.url).map((item) => [item.url, item]));
  const fresh = new Map<string, Item>();
  const changed = new Map<string, Item>();
  const now = Date.now();
  let created = 0;
  let merged = 0;
  for (const entry of [...entries].sort((a, b) => a.at.getTime() - b.at.getTime())) {
    const text = entry.text.trim();
    if (!text) continue;
    const link = entry.url !== undefined ? entry.url : extractFirstUrl(text);
    const existing = link ? byUrl.get(link) : undefined;
    if (existing) {
      const combined = mergeInput(existing.input, text);
      if (combined !== existing.input) {
        const next = { ...existing, input: combined, updatedAt: nextStamp(existing.updatedAt), dirty: 1 as const };
        byUrl.set(link, next);
        if (fresh.has(existing.id)) fresh.set(existing.id, next);
        else changed.set(existing.id, next);
        merged += 1;
      }
      continue;
    }
    const savedAt = new Date(Math.min(entry.at.getTime(), now)).toISOString();
    const item: Item = {
      id: newId(entry.at),
      status: "pending",
      source,
      sourceRef: entry.sourceRef.slice(0, 100),
      url: link,
      title: entry.title?.trim() || fallbackTitle({ pageTitle: "", input: text, url: link }),
      summary: "",
      category: "",
      tags: [],
      favorite: false,
      createdAt: savedAt,
      updatedAt: new Date(now + created).toISOString(),
      error: "",
      siteName: "",
      image: "",
      video: "",
      images: [],
      input: text,
      page: "",
      dirty: 1,
    };
    // Two messages in the same minute would share an id; nudge until it is unique.
    while (fresh.has(item.id) || state.items.some((other) => other.id === item.id)) item.id = newId(new Date(entry.at.getTime() + 1000 * (created + 1)));
    fresh.set(item.id, item);
    if (link) byUrl.set(link, item);
    created += 1;
  }
  const all = [...fresh.values(), ...changed.values()];
  if (all.length) {
    await putItems(all);
    afterLocalChange();
  }
  return { created, merged };
}

export type ItemPatch =Partial<Pick<Item, "title" | "summary" | "category" | "tags" | "favorite" | "status" | "error">>;

export async function updateItem(id: string, patch: ItemPatch): Promise<void> {
  const current = await getItem(id);
  if (!current) return;
  await putItems([{ ...current, ...patch, updatedAt: nextStamp(current.updatedAt), dirty: 1 }]);
  afterLocalChange();
}

/** Asks the PC server to organize this item again (applied the next time a sync reaches it). */
export function requestReorganize(id: string): Promise<void> {
  return updateItem(id, { status: "pending", error: "" });
}

/**
 * Asks the PC to organize every memo whose organizing failed, and only those. They are queued as one
 * batch and the PC works through them one at a time. Returns how many were queued.
 */
export async function retryFailedItems(): Promise<number> {
  const failed = state.items.filter((item) => item.status === "failed");
  if (!failed.length) return 0;
  await putItems(failed.map((item) => ({ ...item, status: "pending" as const, error: "", updatedAt: nextStamp(item.updatedAt), dirty: 1 as const })));
  afterLocalChange();
  return failed.length;
}

export async function removeItem(id: string): Promise<void> {
  await deleteItemWithTombstone(id, new Date().toISOString());
  afterLocalChange();
}
