import { Clock, ImageIcon, Play, Star } from "lucide-react";
import { useState, type DragEvent } from "react";

import { hostnameOf } from "../../shared/item.mjs";
import { DRAG_TYPE } from "./CategoryMenu";
import { ItemActions } from "./ItemActions";
import { Link } from "./Link";
import { hasVideo, thumbnailOf } from "../lib/media";
import { SOURCE_LABELS, STATUS_LABELS, memoTime } from "../lib/ui";
import type { Item } from "../types";

function startDrag(event: DragEvent, item: Item) {
  event.dataTransfer.setData(DRAG_TYPE, item.id);
  event.dataTransfer.effectAllowed = "move";
}

function Thumb({ item, className }: { item: Item; className: string }) {
  const [failed, setFailed] = useState(false);
  const url = thumbnailOf(item);
  return (
    <div className={`${className}${url && !failed ? " has-image" : ""}`}>
      {url && !failed ? (
        <img src={url} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
      ) : (
        <ImageIcon size={22} aria-hidden="true" />
      )}
      {hasVideo(item) && (
        <span className="play-badge small" aria-label="영상">
          <Play size={14} />
        </span>
      )}
    </div>
  );
}

interface ViewProps {
  items: Item[];
  search: string;
  selectedId: string | null;
  shown: number;
}

/**
 * Card view: pictures first, like a board. The whole card opens the memo; the icons in its corner
 * act on it. Cards can be dragged onto a category in the sidebar.
 */
export function CardGrid({ items, search, selectedId, shown }: ViewProps) {
  return (
    <div className="card-grid">
      {items.slice(0, shown).map((item) => (
        <div
          key={item.id}
          className={`tile${item.id === selectedId ? " selected" : ""}`}
          draggable
          onDragStart={(event) => startDrag(event, item)}
        >
          {/* The link is not draggable on its own so a drag always moves the card, not the address. */}
          <Link to={`/item/${item.id}${search}`} className="tile-link" draggable={false}>
            <Thumb item={item} className="tile-thumb" />
            <div className="tile-body">
              <div className="tile-title">
                <span>{item.title || "제목 없음"}</span>
              </div>
              {(item.summary || item.input) && <p className="tile-summary">{item.summary || item.input}</p>}
              {item.tags.length > 0 && (
                <div className="tile-tags">
                  {item.tags.slice(0, 4).map((tag) => (
                    <span key={tag}>#{tag}</span>
                  ))}
                </div>
              )}
              <div className="card-meta">
                {item.category && <span className="chip small">{item.category}</span>}
                {item.status !== "done" && (
                  <span className={`badge ${item.status}`}>
                    <Clock size={12} />
                    {STATUS_LABELS[item.status]}
                  </span>
                )}
                <span className="muted" title={memoTime(item).title}>{memoTime(item).label}</span>
              </div>
            </div>
          </Link>
          <ItemActions item={item} search={search} className="tile-actions" />
        </div>
      ))}
    </div>
  );
}

/** List view: one dense row per memo, with the same icons at the right end. */
export function ListRows({ items, search, selectedId, shown }: ViewProps) {
  return (
    <div className="list-table" role="table" aria-label="메모 목록">
      <div className="list-row head" role="row">
        <div className="row-link" role="presentation">
          <span role="columnheader" />
          <span role="columnheader">제목</span>
          <span role="columnheader">카테고리</span>
          <span role="columnheader">태그</span>
          <span role="columnheader">출처</span>
          <span role="columnheader">날짜</span>
        </div>
        <span className="row-actions-space" aria-hidden="true" />
      </div>
      {items.slice(0, shown).map((item) => (
        <div
          key={item.id}
          className={`list-row${item.id === selectedId ? " selected" : ""}`}
          role="row"
          draggable
          onDragStart={(event) => startDrag(event, item)}
        >
          <Link to={`/item/${item.id}${search}`} className="row-link" draggable={false}>
            <Thumb item={item} className="row-thumb" />
            <span className="row-title" role="cell">
              <strong>
                {item.favorite && <Star size={13} className="fav-icon" aria-label="즐겨찾기" />} {item.title || "제목 없음"}
              </strong>
              <small>{item.summary.split("\n")[0] || hostnameOf(item.url) || item.input}</small>
            </span>
            <span role="cell">{item.category ? <span className="chip small">{item.category}</span> : <span className="muted">-</span>}</span>
            <span className="row-tags" role="cell">
              {item.tags.slice(0, 3).map((tag) => `#${tag}`).join(" ") || "-"}
            </span>
            <span className="muted" role="cell">
              {SOURCE_LABELS[item.source] ?? item.source}
            </span>
            <span className="muted" role="cell" title={memoTime(item).title}>
              {memoTime(item).label}
            </span>
          </Link>
          <ItemActions item={item} search={search} className="row-actions" />
        </div>
      ))}
    </div>
  );
}
