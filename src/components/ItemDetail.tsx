import { ArrowLeft, Copy, ExternalLink, Pencil, RefreshCw, Star, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

import { hostnameOf, normalizeTag } from "../../shared/item.mjs";
import { removeItem, requestReorganize, updateItem, useLibrary } from "../lib/library";
import { goBack, navigate } from "../lib/router";
import { useSyncState } from "../lib/sync";
import { SOURCE_LABELS, STATUS_LABELS, formatDate, linkify, memoTime, toast } from "../lib/ui";
import type { Item } from "../types";
import { MediaPreview } from "./MediaPreview";

function Linkified({ text }: { text: string }) {
  return (
    <>
      {linkify(text).map((part, index) =>
        "url" in part ? (
          <a key={index} href={part.url} target="_blank" rel="noopener noreferrer">
            {part.url}
          </a>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  );
}

export function ItemDetail({
  item,
  search,
  inModal = false,
  startEditing = false,
}: {
  item: Item;
  search: string;
  inModal?: boolean;
  /** Open with the edit form showing (the edit icon on a card or row). */
  startEditing?: boolean;
}) {
  const sync = useSyncState();
  const { items } = useLibrary();
  // Existing categories are offered while typing, so a memo is filed into one that already exists.
  const categoryOptions = [...new Set(items.map((entry) => entry.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ko"));
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [draft, setDraft] = useState({ title: "", summary: "", category: "", tags: "" });

  // Switching to another item must not carry over an open editor or a pending delete confirmation,
  // unless the memo was opened through its edit icon.
  useEffect(() => {
    setConfirmDelete(false);
    if (startEditing) {
      setDraft({ title: item.title, summary: item.summary, category: item.category, tags: item.tags.join(", ") });
      setEditing(true);
    } else {
      setEditing(false);
    }
    // Only a change of memo or of the edit request restarts the editor, not every sync update.
  }, [item.id, startEditing]);

  useEffect(() => {
    if (!confirmDelete) return undefined;
    const timer = window.setTimeout(() => setConfirmDelete(false), 3500);
    return () => window.clearTimeout(timer);
  }, [confirmDelete]);

  const startEdit = () => {
    setDraft({ title: item.title, summary: item.summary, category: item.category, tags: item.tags.join(", ") });
    setEditing(true);
  };

  const saveEdit = async () => {
    // Same rule as the PC's organizer, so tags typed here also work as Obsidian tags.
    const tags = [...new Set(draft.tags.split(/[,\n]/).map((tag) => normalizeTag(tag)).filter(Boolean))];
    await updateItem(item.id, { title: draft.title.trim(), summary: draft.summary.trim(), category: draft.category.trim(), tags });
    setEditing(false);
    toast("수정했어요");
  };

  const copyOriginal = async () => {
    try {
      await navigator.clipboard.writeText(item.input);
      toast("원문을 복사했어요");
    } catch {
      toast("복사하지 못했어요");
    }
  };

  const reorganize = async () => {
    await requestReorganize(item.id);
    toast(sync.phase === "offline" ? "PC에 연결되면 정리해요" : "다시 정리를 요청했어요");
  };

  const remove = async () => {
    await removeItem(item.id);
    toast("삭제했어요");
    navigate(`/${search}`, { replace: true });
  };

  const filterLink = (key: "category" | "tag", value: string) => navigate(`/?${key}=${encodeURIComponent(value)}`);
  const host = hostnameOf(item.url);
  const needsLlm = item.status === "failed" && /LLM|CLI|API|모델/.test(item.error);

  return (
    <article className="detail">
      <div className="detail-bar">
        {inModal ? (
          <span />
        ) : (
          <button type="button" className="icon-btn back-btn" onClick={() => goBack(`/${search}`)} aria-label="목록으로">
            <ArrowLeft size={20} />
          </button>
        )}
        <div className="detail-actions">
          <button
            type="button"
            className={`icon-btn${item.favorite ? " active" : ""}`}
            onClick={() => void updateItem(item.id, { favorite: !item.favorite })}
            aria-label={item.favorite ? "즐겨찾기 해제" : "즐겨찾기"}
            aria-pressed={item.favorite}
          >
            <Star size={19} />
          </button>
          <button type="button" className="icon-btn" onClick={editing ? () => setEditing(false) : startEdit} aria-label="편집">
            <Pencil size={19} />
          </button>
          <button type="button" className="icon-btn" onClick={() => void reorganize()} aria-label="다시 정리" title="다시 정리">
            <RefreshCw size={19} />
          </button>
          <button
            type="button"
            className={`icon-btn danger${confirmDelete ? " armed" : ""}`}
            onClick={() => (confirmDelete ? void remove() : setConfirmDelete(true))}
            aria-label="삭제"
          >
            <Trash2 size={19} />
            {confirmDelete && <span>정말 삭제</span>}
          </button>
        </div>
      </div>

      {editing ? (
        <form
          className="edit-form"
          onSubmit={(event) => {
            event.preventDefault();
            void saveEdit();
          }}
        >
          <label>
            제목
            <input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} maxLength={200} />
          </label>
          <label>
            카테고리 (바꾸면 해당 폴더로 이동해요)
            <input
              list="category-options"
              value={draft.category}
              onChange={(event) => setDraft({ ...draft, category: event.target.value })}
              maxLength={40}
            />
            <datalist id="category-options">
              {categoryOptions.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
          </label>
          <label>
            태그 (쉼표로 구분)
            <input value={draft.tags} onChange={(event) => setDraft({ ...draft, tags: event.target.value })} />
          </label>
          <label>
            요약
            <textarea rows={5} value={draft.summary} onChange={(event) => setDraft({ ...draft, summary: event.target.value })} />
          </label>
          <div className="row">
            <button type="submit" className="btn primary">
              저장
            </button>
            <button type="button" className="btn" onClick={() => setEditing(false)}>
              취소
            </button>
          </div>
        </form>
      ) : (
        <>
          <h1 className="detail-title">{item.title || "제목 없음"}</h1>
          <div className="detail-meta">
            <span>{SOURCE_LABELS[item.source] ?? item.source}</span>
            {item.publishedAt ? (
              <span title={`저장: ${formatDate(item.createdAt)}`}>
                원문 {item.publishedAt.length === 10 ? memoTime(item).label : formatDate(item.publishedAt)}
              </span>
            ) : (
              <span>{formatDate(item.createdAt)}</span>
            )}
            {item.publishedAt && <span className="muted">저장 {formatDate(item.createdAt)}</span>}
            {item.siteName && <span>{item.siteName}</span>}
            <span className={`badge ${item.status}`}>{STATUS_LABELS[item.status]}</span>
          </div>

          {item.url && (
            <a className="source-link" href={item.url} target="_blank" rel="noopener noreferrer">
              <ExternalLink size={15} />
              <span>{host || item.url}</span>
            </a>
          )}

          <MediaPreview item={item} />

          {item.status === "failed" && (
            <div className="notice warn">
              <strong>정리하지 못했어요.</strong>
              <p>{item.error || "알 수 없는 오류"}</p>
              <div className="row">
                <button type="button" className="btn" onClick={() => void reorganize()}>
                  다시 시도
                </button>
                {needsLlm && (
                  <button type="button" className="btn" onClick={() => navigate("/settings")}>
                    LLM 설정 열기
                  </button>
                )}
              </div>
            </div>
          )}
          {(item.status === "pending" || item.status === "processing") && (
            <div className="notice">
              {sync.phase === "offline"
                ? "PC에 연결되면 자동으로 정리돼요. 그 전에도 원문은 이 기기에 안전하게 저장되어 있어요."
                : item.status === "processing"
                  ? "PC에서 정리하는 중이에요…"
                  : "정리 순서를 기다리고 있어요."}
            </div>
          )}

          {item.summary && (
            <section>
              <h2>요약</h2>
              <p className="summary">{item.summary}</p>
            </section>
          )}

          {(item.category || item.tags.length > 0) && (
            <div className="chips">
              {item.category && (
                <button type="button" className="chip" onClick={() => filterLink("category", item.category)}>
                  {item.category}
                </button>
              )}
              {item.tags.map((tag) => (
                <button type="button" key={tag} className="chip ghost" onClick={() => filterLink("tag", tag)}>
                  #{tag}
                </button>
              ))}
            </div>
          )}
        </>
      )}

      <section>
        <div className="section-head">
          <h2>원문</h2>
          <button type="button" className="btn small" onClick={() => void copyOriginal()}>
            <Copy size={14} /> 복사
          </button>
        </div>
        <div className="original">
          <Linkified text={item.input} />
        </div>
      </section>

      {item.page && (
        <details className="page-text">
          <summary>링크 본문 ({item.page.length.toLocaleString("ko-KR")}자)</summary>
          <div className="original">{item.page}</div>
        </details>
      )}
    </article>
  );
}
