import { youtubeIdOf } from "../../shared/item.mjs";
import type { Item } from "../types";

/** What a card or list row shows as its picture: the page's preview, an article picture, or a YouTube frame. */
export function thumbnailOf(item: Item): string {
  if (item.image) return item.image;
  if (item.images?.length) return item.images[0];
  const youtube = youtubeIdOf(item.url);
  return youtube ? `https://i.ytimg.com/vi/${youtube}/hqdefault.jpg` : "";
}

export function hasVideo(item: Item): boolean {
  return Boolean(item.video) || Boolean(youtubeIdOf(item.url));
}

/** Preview pictures for the detail view, the main one first, without repeats. */
export function galleryOf(item: Item): string[] {
  const all = [thumbnailOf(item), ...(item.images ?? [])].filter(Boolean);
  return all.filter((url, index) => all.indexOf(url) === index).slice(0, 8);
}

/** The video that can be played inside the app, or null. */
export function playableVideo(item: Item): { kind: "file"; url: string } | { kind: "youtube"; id: string } | null {
  if (item.video) return { kind: "file", url: item.video };
  const id = youtubeIdOf(item.url);
  return id ? { kind: "youtube", id } : null;
}

/** Stable hue for a category name, so the same category has the same color everywhere. */
export function categoryHue(category: string): number {
  const top = category.split("/")[0] || "none";
  let hash = 0;
  for (let i = 0; i < top.length; i += 1) hash = (hash * 31 + top.charCodeAt(i)) >>> 0;
  return hash % 360;
}
