import { categoryComparator } from "../../shared/sort.mjs";
import type { Item } from "../types";

export type CategorySort = "count" | "name" | "recent";

/** URL value for items that have no category yet (waiting to be organized). */
export const UNCATEGORIZED = "__none__";

export interface CategoryNode {
  name: string;
  /** Full category path, e.g. "네트워크/DNS". */
  path: string;
  /** Items in this category and everything below it. */
  count: number;
  /** When the newest memo in this category (or below it) was saved. */
  latest: string;
  children: CategoryNode[];
}

// Categories nest with "/", the same way the notes are filed into sub-folders (three levels at most).
const MAX_DEPTH = 3;

function segmentsOf(category: string): string[] {
  return category
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, MAX_DEPTH);
}

export function buildCategoryTree(items: Item[], sort: CategorySort = "count"): CategoryNode[] {
  const roots: CategoryNode[] = [];
  const byPath = new Map<string, CategoryNode>();

  for (const item of items) {
    const parts = segmentsOf(item.category);
    let siblings = roots;
    let path = "";
    for (const part of parts) {
      path = path ? `${path}/${part}` : part;
      let node = byPath.get(path);
      if (!node) {
        node = { name: part, path, count: 0, latest: "", children: [] };
        byPath.set(path, node);
        siblings.push(node);
      }
      node.count += 1;
      if (item.createdAt > node.latest) node.latest = item.createdAt;
      siblings = node.children;
    }
  }

  const compare = categoryComparator(sort);
  const order = (nodes: CategoryNode[]) => {
    nodes.sort(compare);
    for (const node of nodes) order(node.children);
  };
  order(roots);
  return roots;
}

export function uncategorizedCount(items: Item[]): number {
  return items.filter((item) => !segmentsOf(item.category).length).length;
}

/** True when the item belongs to the category or to anything below it. */
export function inCategory(item: Item, selected: string): boolean {
  if (!selected) return true;
  if (selected === UNCATEGORIZED) return !segmentsOf(item.category).length;
  const own = segmentsOf(item.category).join("/");
  return own === selected || own.startsWith(`${selected}/`);
}

export function flattenTree(nodes: CategoryNode[], depth = 0): Array<{ node: CategoryNode; depth: number }> {
  return nodes.flatMap((node) => [{ node, depth }, ...flattenTree(node.children, depth + 1)]);
}

/** Every ancestor path of a category ("a/b/c" -> ["a", "a/b"]), so a selected leaf can be shown opened. */
export function ancestorsOf(path: string): string[] {
  const parts = segmentsOf(path);
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/"));
}

export function categoryTitle(selected: string): string {
  if (!selected) return "전체 보관함";
  if (selected === UNCATEGORIZED) return "미분류";
  return segmentsOf(selected).at(-1) ?? selected;
}
