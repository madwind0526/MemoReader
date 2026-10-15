import { X } from "lucide-react";
import { useEffect, useRef } from "react";

import { goBack } from "../lib/router";
import type { Item } from "../types";
import { ItemDetail } from "./ItemDetail";

/** The memo in a pop-up. Closing (X, Esc, or a click outside) goes back to the list behind it. */
export function ItemModal({ item, search, startEditing = false }: { item: Item; search: string; startEditing?: boolean }) {
  const dialog = useRef<HTMLDivElement>(null);
  const close = () => goBack(`/${search}`);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    // The page behind must not scroll while the pop-up is open.
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = overflow;
      previous?.focus?.();
    };
  }, []);

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={item.title || "메모"}
        tabIndex={-1}
        ref={dialog}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            close();
          }
        }}
      >
        <button type="button" className="icon-btn modal-close" onClick={close} aria-label="닫기">
          <X size={20} />
        </button>
        <ItemDetail item={item} search={search} inModal startEditing={startEditing} />
      </div>
    </div>
  );
}
