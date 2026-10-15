import { ArrowDownAZ, ArrowDownZA, BookOpen, CalendarDays, Clock, LayoutGrid, List, Network, RefreshCw, Search, Star, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { ItemCard } from "../components/ItemCard";
import { ItemDetail } from "../components/ItemDetail";
import { ItemModal } from "../components/ItemModal";
import { CardGrid, ListRows } from "../components/ItemViews";
import { MeshView } from "../components/MeshView";
import { QuickAdd } from "../components/QuickAdd";
import { RetryFailedButton } from "../components/RetryFailed";
import { SortBar, type SortOption } from "../components/SortBar";
import { UNCATEGORIZED, buildCategoryTree, categoryTitle, flattenTree, uncategorizedCount } from "../lib/categories";
import { useCategorySort, useIsDesktop, useItemSort, useLibraryView, useViewMode, type ItemSort, type ViewMode } from "../lib/libraryView";
import { navigate } from "../lib/router";
import { syncNow, useSyncState } from "../lib/sync";

const PAGE_SIZE = 40;

const VIEW_MODES: Array<{ mode: ViewMode; label: string; icon: typeof LayoutGrid }> = [
  { mode: "card", label: "카드", icon: LayoutGrid },
  { mode: "list", label: "리스트", icon: List },
  { mode: "mesh", label: "메시", icon: Network },
];

type SortGroup = "created" | "published" | "az" | "za" | "favorite";

const groupOf = (sort: ItemSort): SortGroup => (sort.startsWith("created") ? "created" : sort.startsWith("published") ? "published" : (sort as SortGroup));

/** A date button sorts oldest first on the first click and flips on every click after; the other buttons just pick their order. */
function nextSort(current: ItemSort, group: SortGroup): ItemSort {
  if (group !== "created" && group !== "published") return group;
  if (groupOf(current) !== group) return `${group}-asc`;
  return current.endsWith("-asc") ? `${group}-desc` : `${group}-asc`;
}

/** The sort buttons for the memo list: props for SortBar. */
function useItemSortBar() {
  const [sort, setSort] = useItemSort();
  const active = groupOf(sort);
  const asc = sort.endsWith("-asc");
  const dateOption = (group: "created" | "published", name: string, icon: ReactNode): SortOption<SortGroup> => {
    const on = active === group;
    const mark = on ? (asc ? "↑" : "↓") : "";
    return {
      key: group,
      label: `${name} (${on ? (asc ? "오름차순, 오래된 글 먼저" : "내림차순, 최근 글 먼저") : "클릭하면 오름차순"})`,
      icon: (
        <span className="sort-dir">
          {icon}
          {mark && <small>{mark}</small>}
        </span>
      ),
    };
  };
  const options: Array<SortOption<SortGroup>> = [
    dateOption("created", "등록 날짜 순", <Clock size={15} />),
    dateOption("published", "원문 날짜 순", <CalendarDays size={15} />),
    { key: "az", label: "제목 가나다순", icon: <ArrowDownAZ size={15} /> },
    { key: "za", label: "제목 역순", icon: <ArrowDownZA size={15} /> },
    { key: "favorite", label: "즐겨찾기 먼저", icon: <Star size={15} /> },
  ];
  return { options, value: active, onChange: (group: SortGroup) => setSort(nextSort(sort, group)) };
}

/** Reveals more items as the end of the list scrolls into view. */
function useProgressive(total: number, resetKey: string) {
  const [shown, setShown] = useState(PAGE_SIZE);
  const sentinel = useRef<HTMLDivElement>(null);

  useEffect(() => setShown(PAGE_SIZE), [resetKey]);
  useEffect(() => {
    const node = sentinel.current;
    if (!node || shown >= total) return undefined;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setShown((count) => count + PAGE_SIZE);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [shown, total]);

  return { shown, sentinel };
}

function Empty({ filtered }: { filtered: boolean }) {
  return (
    <div className="empty">
      <BookOpen size={34} />
      <p>{filtered ? "조건에 맞는 항목이 없어요." : "아직 저장한 항목이 없어요."}</p>
      {!filtered && <p className="muted">링크나 글을 붙여넣어 저장해 보세요. 폰에서는 다른 앱의 공유 버튼으로도 저장할 수 있어요.</p>}
    </div>
  );
}

// ---- PC -------------------------------------------------------------------------------------

function DesktopLibrary({ selectedId }: { selectedId: string | null }) {
  const { items, loaded, error, filtered, filter, query, setQuery, select, search, editing, failedCount } = useLibraryView();
  const [mode, setMode] = useViewMode();
  const sortBar = useItemSortBar();
  const sync = useSyncState();
  const { shown, sentinel } = useProgressive(filtered.length, `${query}|${filter.category}|${filter.tag}|${filter.view}|${mode}`);

  const todoCount = useMemo(() => items.filter((item) => item.status !== "done").length, [items]);
  const selected = selectedId ? (items.find((item) => item.id === selectedId) ?? null) : null;
  const hasFilter = Boolean(filter.category || filter.tag || filter.view || query);
  const title = filter.view === "fav" ? "즐겨찾기" : filter.view === "todo" ? "정리 필요" : categoryTitle(filter.category);

  return (
    <div className="lib-desktop">
      <header className="lib-toolbar">
        <div className="lib-title">
          <h1>{title}</h1>
          <span className="muted">
            {filtered.length}개{filter.category.includes("/") ? ` · ${filter.category.split("/").join(" / ")}` : ""}
          </span>
        </div>

        <div className="search lib-search">
          <Search size={17} />
          <input type="search" value={query} placeholder="제목, 요약, 태그, 원문 검색" onChange={(event) => setQuery(event.target.value)} aria-label="검색" />
          {query && (
            <button type="button" className="icon-btn small" onClick={() => setQuery("")} aria-label="검색어 지우기">
              <X size={16} />
            </button>
          )}
        </div>

        <div className="seg view-switch" role="radiogroup" aria-label="보기 방식">
          {VIEW_MODES.map(({ mode: value, label, icon: Icon }) => (
            <button
              type="button"
              key={value}
              role="radio"
              aria-checked={mode === value}
              aria-label={label}
              title={label}
              className={mode === value ? "active" : ""}
              onClick={() => setMode(value)}
            >
              <Icon size={16} /> <span className="view-label">{label}</span>
            </button>
          ))}
        </div>
      </header>

      <QuickAdd compact onSaved={(id) => navigate(`/item/${id}${search}`)} />

      <div className="lib-filterbar">
        <div className="filters" role="toolbar" aria-label="필터">
          <button type="button" className={`chip${!hasFilter ? " active" : ""}`} onClick={() => select({ category: "", tag: "", view: "" })}>
            전체
          </button>
          <button type="button" className={`chip${filter.view === "fav" ? " active" : ""}`} onClick={() => select({ view: filter.view === "fav" ? "" : "fav" })}>
            <Star size={13} /> 즐겨찾기
          </button>
          {todoCount > 0 && (
            <button type="button" className={`chip${filter.view === "todo" ? " active" : ""}`} onClick={() => select({ view: filter.view === "todo" ? "" : "todo" })}>
              정리 필요 {todoCount}
            </button>
          )}
          {failedCount > 0 && (
            <button type="button" className={`chip${filter.view === "failed" ? " active" : ""}`} onClick={() => select({ view: filter.view === "failed" ? "" : "failed" })}>
              정리 실패 {failedCount}
            </button>
          )}
          {filter.category && (
            <button type="button" className="chip active" onClick={() => select({ category: "" })} title="카테고리 해제">
              {categoryTitle(filter.category)} <X size={13} />
            </button>
          )}
          {filter.tag && (
            <button type="button" className="chip active" onClick={() => select({ tag: "" })} title="태그 해제">
              #{filter.tag} <X size={13} />
            </button>
          )}
        </div>

        <div className="lib-tools">
          {failedCount > 0 && <RetryFailedButton count={failedCount} />}
          <SortBar
            {...sortBar}
            leading={
              <button type="button" aria-label="지금 동기화" title="지금 동기화" onClick={() => void syncNow()}>
                <RefreshCw size={15} className={sync.phase === "syncing" ? "spin" : ""} />
              </button>
            }
          />
        </div>
      </div>

      {error && <div className="notice warn">{error}</div>}

      <div className="lib-body">
        {mode === "mesh" ? (
          <MeshView items={filtered} onOpen={(id) => navigate(`/item/${id}${search}`)} />
        ) : filtered.length ? (
          <>
            {mode === "card" ? (
              <CardGrid items={filtered} search={search} selectedId={selectedId} shown={shown} />
            ) : (
              <ListRows items={filtered} search={search} selectedId={selectedId} shown={shown} />
            )}
            {shown < filtered.length && <div ref={sentinel} className="sentinel" />}
          </>
        ) : (
          loaded && <Empty filtered={hasFilter} />
        )}
      </div>

      {selected && <ItemModal item={selected} search={search} startEditing={editing} />}
      {selectedId && !selected && loaded && (
        <div className="notice warn lib-missing">
          항목을 찾을 수 없어요. 삭제되었거나 아직 동기화되지 않았을 수 있어요.{" "}
          <button type="button" className="btn small" onClick={() => navigate(`/${search}`, { replace: true })}>
            닫기
          </button>
        </div>
      )}
    </div>
  );
}

// ---- phone ----------------------------------------------------------------------------------

function MobileLibrary({ selectedId }: { selectedId: string | null }) {
  const { items, loaded, error, filtered, filter, query, setQuery, select, search, failedCount } = useLibraryView();
  const sortBar = useItemSortBar();
  const { shown, sentinel } = useProgressive(filtered.length, `${query}|${filter.category}|${filter.tag}|${filter.view}`);
  const [categorySort] = useCategorySort();

  const tree = useMemo(() => buildCategoryTree(items, categorySort), [items, categorySort]);
  const options = useMemo(() => flattenTree(tree), [tree]);
  const loose = useMemo(() => uncategorizedCount(items), [items]);
  const todoCount = useMemo(() => items.filter((item) => item.status !== "done").length, [items]);
  const selected = selectedId ? (items.find((item) => item.id === selectedId) ?? null) : null;
  const hasFilter = Boolean(filter.category || filter.tag || filter.view || query);

  return (
    <div className={`library${selectedId ? " has-selection" : ""}`}>
      <section className="list-pane" aria-label="보관함 목록">
        <label className="category-select">
          <span className="sr-only">카테고리</span>
          <select value={filter.category} onChange={(event) => select({ category: event.target.value })} aria-label="카테고리 선택">
            <option value="">모든 카테고리 ({items.length})</option>
            {options.map(({ node, depth }) => (
              <option key={node.path} value={node.path}>
                {`${"  ".repeat(depth)}${depth ? "└ " : ""}${node.name} (${node.count})`}
              </option>
            ))}
            {loose > 0 && <option value={UNCATEGORIZED}>미분류 ({loose})</option>}
          </select>
        </label>

        <div className="search">
          <Search size={17} />
          <input type="search" value={query} placeholder="제목, 요약, 태그, 원문 검색" onChange={(event) => setQuery(event.target.value)} aria-label="검색" />
          {query && (
            <button type="button" className="icon-btn small" onClick={() => setQuery("")} aria-label="검색어 지우기">
              <X size={16} />
            </button>
          )}
        </div>

        <div className="filter-row">
        <div className="filters" role="toolbar" aria-label="필터">
          <button type="button" className={`chip${!filter.view && !filter.tag ? " active" : ""}`} onClick={() => select({ view: "", tag: "" })}>
            전체 {filtered.length}
          </button>
          <button type="button" className={`chip${filter.view === "fav" ? " active" : ""}`} onClick={() => select({ view: filter.view === "fav" ? "" : "fav" })}>
            <Star size={13} /> 즐겨찾기
          </button>
          {todoCount > 0 && (
            <button type="button" className={`chip${filter.view === "todo" ? " active" : ""}`} onClick={() => select({ view: filter.view === "todo" ? "" : "todo" })}>
              정리 필요 {todoCount}
            </button>
          )}
          {failedCount > 0 && (
            <button type="button" className={`chip${filter.view === "failed" ? " active" : ""}`} onClick={() => select({ view: filter.view === "failed" ? "" : "failed" })}>
              정리 실패 {failedCount}
            </button>
          )}
          {filter.tag && (
            <button type="button" className="chip active" onClick={() => select({ tag: "" })}>
              #{filter.tag} <X size={13} />
            </button>
          )}
        </div>
          <SortBar {...sortBar} compact />
        </div>

        {filter.view === "failed" && failedCount > 0 && <RetryFailedButton count={failedCount} wide />}

        {error && <div className="notice warn">{error}</div>}

        <div className="cards">
          {filtered.slice(0, shown).map((item) => (
            <ItemCard key={item.id} item={item} selected={item.id === selectedId} search={search} />
          ))}
          {shown < filtered.length && <div ref={sentinel} className="sentinel" />}
          {loaded && !filtered.length && <Empty filtered={hasFilter} />}
        </div>
      </section>

      <section className="detail-pane" aria-label="상세">
        {selected ? (
          <ItemDetail item={selected} search={search} />
        ) : (
          <div className="empty">
            <BookOpen size={34} />
            <p>{selectedId && loaded ? "항목을 찾을 수 없어요." : "항목을 선택하세요."}</p>
          </div>
        )}
      </section>
    </div>
  );
}

export function LibraryPage({ selectedId }: { selectedId: string | null }) {
  const desktop = useIsDesktop();
  return desktop ? <DesktopLibrary selectedId={selectedId} /> : <MobileLibrary selectedId={selectedId} />;
}
