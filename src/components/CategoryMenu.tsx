import { ArrowDownAZ, ArrowDownWideNarrow, BookOpen, ChevronDown, ChevronRight, Clock, Folder, FolderOpen } from "lucide-react";
import { useEffect, useMemo, useState, type DragEvent } from "react";

import { UNCATEGORIZED, ancestorsOf, buildCategoryTree, uncategorizedCount, type CategoryNode, type CategorySort } from "../lib/categories";
import { libraryUrl, useCategorySort } from "../lib/libraryView";
import { updateItem } from "../lib/library";
import { useLocation } from "../lib/router";
import { toast } from "../lib/ui";
import { Link } from "./Link";
import { SortBar, type SortOption } from "./SortBar";
import type { Item } from "../types";

const CATEGORY_SORT_OPTIONS: Array<SortOption<CategorySort>> = [
  { key: "count", label: "메모 많은 순", icon: <ArrowDownWideNarrow size={14} /> },
  { key: "name", label: "이름 가나다순", icon: <ArrowDownAZ size={14} /> },
  { key: "recent", label: "최근 저장 순", icon: <Clock size={14} /> },
];

/** Drag-and-drop payload: the id of the memo being moved to another category. */
export const DRAG_TYPE = "application/x-memoreader-item";

const OPEN_KEY = "memoreader.sidebar.v1";

interface OpenState {
  library: boolean;
  nodes: string[];
}

function readOpenState(): OpenState {
  try {
    const parsed = JSON.parse(localStorage.getItem(OPEN_KEY) ?? "null") as Partial<OpenState> | null;
    if (parsed) return { library: parsed.library !== false, nodes: Array.isArray(parsed.nodes) ? parsed.nodes.filter((entry) => typeof entry === "string") : [] };
  } catch {
    // Storage can be blocked or hold something else; start with the defaults.
  }
  return { library: true, nodes: [] };
}

function hasDraggedItem(event: DragEvent): boolean {
  return Array.from(event.dataTransfer.types).includes(DRAG_TYPE);
}

/**
 * "보관함" with its categories underneath as a collapsible tree. Choosing one shows only its
 * memos, and a memo dropped on a category moves there.
 */
export function CategoryMenu({ items, libraryActive }: { items: Item[]; libraryActive: boolean }) {
  const location = useLocation();
  const selected = libraryActive ? (location.params.get("category") ?? "") : "";
  const [categorySort, setCategorySort] = useCategorySort();
  const tree = useMemo(() => buildCategoryTree(items, categorySort), [items, categorySort]);
  const loose = useMemo(() => uncategorizedCount(items), [items]);
  const [open, setOpen] = useState<OpenState>(readOpenState);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(OPEN_KEY, JSON.stringify(open));
    } catch {
      // Ignore: the menu still works, it just forgets its open state.
    }
  }, [open]);

  // Selecting a nested category (from a tag chip or a link) must show where it lives.
  useEffect(() => {
    const parents = ancestorsOf(selected);
    if (!parents.length) return;
    setOpen((current) => (parents.every((path) => current.nodes.includes(path)) ? current : { ...current, nodes: [...new Set([...current.nodes, ...parents])] }));
  }, [selected]);

  const toggleNode = (path: string) =>
    setOpen((current) => ({ ...current, nodes: current.nodes.includes(path) ? current.nodes.filter((entry) => entry !== path) : [...current.nodes, path] }));

  const move = async (event: DragEvent, category: string, label: string) => {
    event.preventDefault();
    setDropTarget(null);
    const id = event.dataTransfer.getData(DRAG_TYPE);
    if (!id) return;
    await updateItem(id, { category });
    toast(`“${label}”(으)로 옮겼어요`);
  };

  const dropProps = (key: string, category: string, label: string) => ({
    onDragOver: (event: DragEvent) => {
      if (!hasDraggedItem(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      setDropTarget(key);
    },
    onDragLeave: () => setDropTarget((current) => (current === key ? null : current)),
    onDrop: (event: DragEvent) => void move(event, category, label),
  });

  const renderNode = (node: CategoryNode, depth: number) => {
    const expanded = open.nodes.includes(node.path);
    const hasChildren = node.children.length > 0;
    const active = selected === node.path;
    return (
      <li key={node.path}>
        <div
          className={`cat-row${active ? " active" : ""}${dropTarget === node.path ? " drop" : ""}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          {...dropProps(node.path, node.path, node.name)}
        >
          {hasChildren ? (
            <button type="button" className="cat-toggle" onClick={() => toggleNode(node.path)} aria-expanded={expanded} aria-label={`${node.name} ${expanded ? "접기" : "펼치기"}`}>
              {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
            </button>
          ) : (
            <span className="cat-toggle spacer" aria-hidden="true" />
          )}
          <Link to={libraryUrl({ category: node.path })} className="cat-link" aria-current={active ? "true" : undefined}>
            {active ? <FolderOpen size={16} /> : <Folder size={16} />}
            <span className="cat-name">{node.name}</span>
            <span className="cat-count">{node.count}</span>
          </Link>
        </div>
        {hasChildren && expanded && <ul className="cat-list">{node.children.map((child) => renderNode(child, depth + 1))}</ul>}
      </li>
    );
  };

  const allActive = libraryActive && selected === "";
  return (
    <div className="cat-menu">
      <div className={`nav-link library-link${libraryActive ? " active" : ""}`}>
        <Link to="/" className="library-link-main" aria-current={allActive ? "page" : undefined}>
          <BookOpen size={19} />
          <span>보관함</span>
          <span className="cat-count">{items.length}</span>
        </Link>
        <button
          type="button"
          className="cat-toggle strong"
          onClick={() => setOpen((current) => ({ ...current, library: !current.library }))}
          aria-expanded={open.library}
          aria-label={open.library ? "카테고리 접기" : "카테고리 펼치기"}
        >
          {open.library ? <ChevronDown size={17} /> : <ChevronRight size={17} />}
        </button>
      </div>

      {open.library && tree.length > 1 && (
        <div className="cat-sort">
          <SortBar options={CATEGORY_SORT_OPTIONS} value={categorySort} onChange={setCategorySort} label="카테고리 정렬" compact />
        </div>
      )}

      {open.library && (
        <ul className="cat-list root" aria-label="카테고리">
          {tree.map((node) => renderNode(node, 0))}
          {loose > 0 && (
            <li>
              <div
                className={`cat-row${selected === UNCATEGORIZED ? " active" : ""}${dropTarget === UNCATEGORIZED ? " drop" : ""}`}
                style={{ paddingLeft: 8 }}
                {...dropProps(UNCATEGORIZED, "", "미분류")}
              >
                <span className="cat-toggle spacer" aria-hidden="true" />
                <Link to={libraryUrl({ category: UNCATEGORIZED })} className="cat-link">
                  <Folder size={16} />
                  <span className="cat-name">미분류</span>
                  <span className="cat-count">{loose}</span>
                </Link>
              </div>
            </li>
          )}
          {!tree.length && loose === 0 && <li className="muted small-text cat-empty">아직 카테고리가 없어요</li>}
        </ul>
      )}
    </div>
  );
}
