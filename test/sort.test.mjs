import assert from "node:assert/strict";
import test from "node:test";

import { categoryComparator, sortItems } from "../shared/sort.mjs";

const item = (id, title, createdAt, favorite = false) => ({ id, title, createdAt, favorite });
const items = [
  item("1", "나비", "2026-10-10T00:00:00Z"),
  item("2", "가방", "2026-10-12T00:00:00Z", true),
  item("3", "다람쥐", "2026-10-11T00:00:00Z"),
  item("4", "가방", "2026-10-09T00:00:00Z"),
  item("5", "", "2026-10-13T00:00:00Z"),
];
const ids = (list) => list.map((entry) => entry.id).join("");

test("items sort newest first by default and oldest first on request", () => {
  assert.equal(ids(sortItems(items, "newest")), "52314");
  assert.equal(ids(sortItems(items, "oldest")), "41325");
  assert.equal(ids(sortItems(items, "nonsense")), "52314", "an unknown key falls back to newest");
});

test("items sort by title in Korean order, ties broken newest first", () => {
  assert.equal(ids(sortItems(items, "az")), "52413", "empty title first, then 가방 (newer before older), 나비, 다람쥐");
  assert.equal(ids(sortItems(items, "za")), "31245", "다람쥐, 나비, 가방 (newer first), then the empty title");
});

test("favorites come first, then newest", () => {
  assert.equal(ids(sortItems(items, "favorite")), "25314");
});

test("sorting never changes the list it was given", () => {
  const before = ids(items);
  sortItems(items, "az");
  assert.equal(ids(items), before);
});

test("category order: by count, by name, by most recent memo", () => {
  const nodes = [
    { name: "나", count: 2, latest: "2026-10-10" },
    { name: "가", count: 5, latest: "2026-10-01" },
    { name: "다", count: 5, latest: "2026-10-12" },
    { name: "라", count: 1, latest: "2026-10-11" },
  ];
  const names = (key) => [...nodes].sort(categoryComparator(key)).map((node) => node.name).join("");
  assert.equal(names("count"), "가다나라", "most memos first, equal counts by name");
  assert.equal(names("name"), "가나다라");
  assert.equal(names("recent"), "다라나가");
});

test("both date sorts have both directions: saved day and original day", () => {
  assert.equal(ids(sortItems(items, "created-desc")), "52314");
  assert.equal(ids(sortItems(items, "created-asc")), "41325");
  const dated = [
    { id: "a", createdAt: "2026-10-01T00:00:00Z", publishedAt: "2020-01-01" },
    { id: "b", createdAt: "2026-10-02T00:00:00Z", publishedAt: "2024-01-01" },
    { id: "c", createdAt: "2026-10-03T00:00:00Z", publishedAt: "" },
    { id: "d", createdAt: "2026-10-04T00:00:00Z", publishedAt: "2022-01-01" },
  ];
  assert.equal(ids(sortItems(dated, "published-asc")), "adbc".replace("bc", "bc"), "no original date counts as the saved day, 2026");
  assert.equal(ids(sortItems(dated, "published-desc")), "cbda");
  assert.equal(ids(sortItems(dated, "published")), "cbda", "the old key still works");
});
