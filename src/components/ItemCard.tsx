import { Clock, Play, Star } from "lucide-react";
import { useState } from "react";

import { hostnameOf } from "../../shared/item.mjs";
import type { Item } from "../types";
import { hasVideo, thumbnailOf } from "../lib/media";
import { SOURCE_LABELS, STATUS_LABELS, memoTime } from "../lib/ui";
import { Link } from "./Link";

interface ItemCardProps {
  item: Item;
  selected: boolean;
  search: string;
}

export function ItemCard({ item, selected, search }: ItemCardProps) {
  const [imageFailed, setImageFailed] = useState(false);
  const blurb = item.summary || item.input.replace(/\s+/g, " ").trim().slice(0, 140);
  const host = hostnameOf(item.url);
  const waiting = item.status !== "done";

  return (
    <Link to={`/item/${item.id}${search}`} className={`card${selected ? " selected" : ""}`} aria-current={selected ? "true" : undefined}>
      <div className="card-body">
        <div className="card-title">
          {item.favorite && <Star size={14} className="fav-icon" aria-label="즐겨찾기" />}
          <span>{item.title || "제목 없음"}</span>
        </div>
        {blurb && <p className="card-blurb">{blurb}</p>}
        <div className="card-meta">
          {item.category && <span className="chip small">{item.category}</span>}
          {waiting && (
            <span className={`badge ${item.status}`}>
              <Clock size={12} />
              {STATUS_LABELS[item.status]}
            </span>
          )}
          {host && <span className="muted">{host}</span>}
          <span className="muted" title={memoTime(item).title}>
            {SOURCE_LABELS[item.source] ?? item.source} · {memoTime(item).label}
          </span>
        </div>
      </div>
      {thumbnailOf(item) && !imageFailed && (
        <div className="card-thumb-wrap">
          <img className="card-thumb" src={thumbnailOf(item)} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setImageFailed(true)} />
          {hasVideo(item) && (
            <span className="play-badge small" aria-label="영상">
              <Play size={14} />
            </span>
          )}
        </div>
      )}
    </Link>
  );
}
