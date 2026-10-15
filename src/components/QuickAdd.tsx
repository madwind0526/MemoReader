import { ClipboardPaste, Plus } from "lucide-react";
import { useState } from "react";

import { addItem } from "../lib/library";
import { toast } from "../lib/ui";

/** One-box capture used on the library screen and the add screen. */
export function QuickAdd({
  rows = 2,
  autoFocus = false,
  compact = false,
  onSaved,
}: {
  rows?: number;
  autoFocus?: boolean;
  /** One line that grows when focused, for the desktop toolbar. */
  compact?: boolean;
  onSaved?: (id: string) => void;
}) {
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!text.trim() || saving) return;
    setSaving(true);
    try {
      const { item, duplicate, merged } = await addItem({ text });
      setText("");
      toast(duplicate ? (merged ? "이미 저장된 링크예요. 메모를 덧붙였어요" : "이미 저장된 링크예요") : "저장했어요");
      onSaved?.(item.id);
    } catch {
      toast("저장하지 못했어요");
    } finally {
      setSaving(false);
    }
  };

  const paste = async () => {
    try {
      const clip = await navigator.clipboard.readText();
      if (clip) setText((current) => (current ? `${current}\n${clip}` : clip));
    } catch {
      toast("붙여넣기 권한이 없어요. 입력창을 길게 눌러 붙여넣어 주세요");
    }
  };

  return (
    <form
      className={`quick-add${compact ? " compact" : ""}`}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <textarea
        value={text}
        rows={compact ? 1 : rows}
        autoFocus={autoFocus}
        placeholder="링크나 글을 붙여넣어 저장하세요"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            void save();
          }
        }}
        aria-label="저장할 링크 또는 글"
      />
      <div className="row">
        <button type="button" className="btn" onClick={() => void paste()}>
          <ClipboardPaste size={16} /> 붙여넣기
        </button>
        <button type="submit" className="btn primary" disabled={!text.trim() || saving}>
          <Plus size={16} /> 저장
        </button>
      </div>
    </form>
  );
}
