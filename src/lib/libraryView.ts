import { useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { CATEGORY_SORTS, ITEM_SORTS, sortItems } from "../../shared/sort.mjs";
import type { Item } from "../types";
import { inCategory, type CategorySort } from "./categories";
import { useLibrary } from "./library";
import { navigate, useLocation } from "./router";

export type ViewMode = "card" | "list" | "mesh";
export type QuickView = "" | "fav" | "todo" | "failed";
export type ItemSort = "created-desc" | "created-asc" | "published-desc" | "published-asc" | "az" | "za" | "favorite";

/** A remembered choice (sort order) shared by every component that reads it. */
function createPreference<T extends string>(key: string, allowed: readonly T[], fallback: T) {
  const listeners = new Set<() => void>();
  const read = (): T => {
    try {
      const saved = localStorage.getItem(key);
      if (saved && (allowed as readonly string[]).includes(saved)) return saved as T;
    } catch {
      // Storage can be blocked; the default order is fine.
    }
    return fallback;
  };
  let current = read();
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  return function usePreference(): [T, (next: T) => void] {
    const value = useSyncExternalStore(subscribe, () => current);
    const set = (next: T) => {
      current = next;
      try {
        localStorage.setItem(key, next);
      } catch {
        // Ignore: the choice still applies for this session.
      }
      for (const listener of listeners) listener();
    };
    return [value, set];
  };
}

export const useItemSort = createPreference<ItemSort>("memoreader.itemSort", ITEM_SORTS as readonly ItemSort[], "created-desc");
export const useCategorySort = createPreference<CategorySort>("memoreader.categorySort", CATEGORY_SORTS as readonly CategorySort[], "count");

export interface LibraryFilter {
  category: string;
  tag: string;
  view: QuickView;
}

/** The address of the library for a filter. Everything lives in the URL so back/forward work. */
export function libraryUrl(filter: Partial<LibraryFilter>): string {
  const params = new URLSearchParams();
  if (filter.category) params.set("category", filter.category);
  if (filter.tag) params.set("tag", filter.tag);
  if (filter.view) params.set("view", filter.view);
  const text = params.toString();
  return text ? `/?${text}` : "/";
}

function matchesText(item: Item, terms: string[]): boolean {
  if (!terms.length) return true;
  const haystack = [item.title, item.summary, item.category, item.tags.join(" "), item.url, item.input.slice(0, 2000)].join("\n").toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

/** The library's items, the filter taken from the URL, and the search text. */
export function useLibraryView() {
  const { items, loaded, error } = useLibrary();
  const location = useLocation();
  const [query, setQuery] = useState("");

  const category = location.params.get("category") ?? "";
  const tag = location.params.get("tag") ?? "";
  const rawView = location.params.get("view");
  const view: QuickView = rawView === "fav" || rawView === "todo" || rawView === "failed" ? rawView : "";
  const [sort] = useItemSort();

  const filtered = useMemo(() => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const matching = items.filter((item) => {
      if (!inCategory(item, category)) return false;
      if (tag && !item.tags.includes(tag)) return false;
      if (view === "fav" && !item.favorite) return false;
      if (view === "todo" && item.status === "done") return false;
      if (view === "failed" && item.status !== "failed") return false;
      return matchesText(item, terms);
    });
    return sortItems(matching, sort) as Item[];
  }, [items, query, category, tag, view, sort]);

  // Counted over everything, not just what the filters currently show.
  const failedCount = useMemo(() => items.filter((item) => item.status === "failed").length, [items]);

  const filter: LibraryFilter = { category, tag, view };
  const select = (changes: Partial<LibraryFilter>) => navigate(libraryUrl({ ...filter, ...changes }));

  // "edit=1" asks for the pop-up to open in edit mode; it belongs to that one visit, not to the filter.
  const editing = location.params.get("edit") === "1";
  const filterParams = new URLSearchParams(location.params);
  filterParams.delete("edit");
  const search = filterParams.toString() ? `?${filterParams.toString()}` : "";

  return { items, loaded, error, filtered, filter, query, setQuery, select, search, editing, failedCount };
}

// ---- screen size and remembered view mode ----------------------------------------------------

const DESKTOP_QUERY = "(min-width: 1000px)";

/** True on screens wide enough for the sidebar layout (the same breakpoint the stylesheet uses). */
export function useIsDesktop(): boolean {
  return useSyncExternalStore(
    (listener) => {
      const media = window.matchMedia(DESKTOP_QUERY);
      media.addEventListener("change", listener);
      return () => media.removeEventListener("change", listener);
    },
    () => window.matchMedia(DESKTOP_QUERY).matches,
  );
}

const VIEW_KEY = "memoreader.viewMode";

export function useViewMode(): [ViewMode, (mode: ViewMode) => void] {
  const [mode, setMode] = useState<ViewMode>(() => {
    try {
      const saved = localStorage.getItem(VIEW_KEY);
      if (saved === "card" || saved === "list" || saved === "mesh") return saved;
    } catch {
      // Storage can be blocked; the default view is fine.
    }
    return "card";
  });
  useEffect(() => {
    try {
      localStorage.setItem(VIEW_KEY, mode);
    } catch {
      // Ignore: the choice still applies for this session.
    }
  }, [mode]);
  return [mode, setMode];
}
