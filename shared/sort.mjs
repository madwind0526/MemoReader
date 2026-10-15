// Sort orders for memos and for categories. Pure functions so the browser and the tests share them.

// created = the day the memo was saved, published = the day the original was written. Each has both directions.
export const ITEM_SORTS = ["created-desc", "created-asc", "published-desc", "published-asc", "az", "za", "favorite"];
export const CATEGORY_SORTS = ["count", "name", "recent"];

const KOREAN_ORDER = (a, b) => String(a ?? "").localeCompare(String(b ?? ""), "ko", { numeric: true, sensitivity: "base" });
const NEWEST_FIRST = (a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || String(b.id).localeCompare(String(a.id));

/** The original publish time when known, otherwise the time the memo was saved. */
const eventTime = (item) => String(item.publishedAt || item.createdAt);
const PUBLISHED_FIRST = (a, b) => eventTime(b).localeCompare(eventTime(a)) || NEWEST_FIRST(a, b);
const PUBLISHED_LAST = (a, b) => eventTime(a).localeCompare(eventTime(b)) || NEWEST_FIRST(b, a);

/** A sorted copy. Equal items keep a stable, newest-first order so the list never jumps around. */
export function sortItems(items, key) {
  const list = [...items];
  switch (key) {
    case "created-asc":
    case "oldest": // the names used before both directions existed
      return list.sort((a, b) => NEWEST_FIRST(b, a));
    case "published-desc":
    case "published":
      return list.sort(PUBLISHED_FIRST);
    case "published-asc":
      return list.sort(PUBLISHED_LAST);
    case "az":
      return list.sort((a, b) => KOREAN_ORDER(a.title, b.title) || NEWEST_FIRST(a, b));
    case "za":
      return list.sort((a, b) => KOREAN_ORDER(b.title, a.title) || NEWEST_FIRST(a, b));
    case "favorite":
      return list.sort((a, b) => Number(Boolean(b.favorite)) - Number(Boolean(a.favorite)) || NEWEST_FIRST(a, b));
    default:
      return list.sort(NEWEST_FIRST);
  }
}

/**
 * Comparator for category tree nodes ({ name, count, latest }): by memo count, by name, or by the most
 * recently saved memo inside. Ties fall back to the name so the order is always the same.
 */
export function categoryComparator(key) {
  switch (key) {
    case "name":
      return (a, b) => KOREAN_ORDER(a.name, b.name);
    case "recent":
      return (a, b) => String(b.latest).localeCompare(String(a.latest)) || KOREAN_ORDER(a.name, b.name);
    default:
      return (a, b) => b.count - a.count || KOREAN_ORDER(a.name, b.name);
  }
}
