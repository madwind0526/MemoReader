import { Pencil, Star, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

import { removeItem, updateItem } from "../lib/library";
import { navigate } from "../lib/router";
import { toast } from "../lib/ui";
import type { Item } from "../types";

/** Address that opens the memo pop-up already in edit mode. */
export function editUrl(id: string, search: string): string {
  const params = new URLSearchParams(search);
  params.set("edit", "1");
  return `/item/${id}?${params.toString()}`;
}

/**
 * Favorite, edit and delete for a card or a list row. Delete asks for a second press, so one stray
 * click never removes a memo.
 */
export function ItemActions({ item, search, className = "" }: { item: Item; search: string; className?: string }) {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return undefined;
    const timer = window.setTimeout(() => setArmed(false), 3500);
    return () => window.clearTimeout(timer);
  }, [armed]);

  const toggleFavorite = async () => {
    await updateItem(item.id, { favorite: !item.favorite });
    toast(item.favorite ? "즐겨찾기를 해제했어요" : "즐겨찾기에 추가했어요");
  };

  const remove = async () => {
    await removeItem(item.id);
    toast("삭제했어요");
  };

  return (
    <div className={`item-actions ${className}`.trim()}>
      <button
        type="button"
        className={`icon-btn act${item.favorite ? " active" : ""}`}
        onClick={() => void toggleFavorite()}
        aria-pressed={item.favorite}
        aria-label={item.favorite ? "즐겨찾기 해제" : "즐겨찾기"}
        title={item.favorite ? "즐겨찾기 해제" : "즐겨찾기"}
      >
        <Star size={17} />
      </button>
      <button type="button" className="icon-btn act" onClick={() => navigate(editUrl(item.id, search))} aria-label="수정" title="수정">
        <Pencil size={17} />
      </button>
      <button
        type="button"
        className={`icon-btn act danger${armed ? " armed" : ""}`}
        onClick={() => (armed ? void remove() : setArmed(true))}
        aria-label={armed ? "한 번 더 누르면 삭제" : "삭제"}
        title={armed ? "한 번 더 누르면 삭제" : "삭제"}
      >
        <Trash2 size={17} />
        {armed && <span>삭제</span>}
      </button>
    </div>
  );
}
