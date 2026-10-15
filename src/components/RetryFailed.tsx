import { RotateCw } from "lucide-react";
import { useState } from "react";

import { retryFailedItems } from "../lib/library";
import { toast } from "../lib/ui";

/** Re-queues only the memos whose organizing failed. Shown only while there are some. */
export function RetryFailedButton({ count, wide = false }: { count: number; wide?: boolean }) {
  const [busy, setBusy] = useState(false);

  const retry = async () => {
    setBusy(true);
    try {
      const queued = await retryFailedItems();
      toast(queued ? `실패했던 ${queued}개를 다시 정리해요. 한 건씩 차례로 처리돼요` : "다시 정리할 항목이 없어요");
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      className={`btn small retry-failed${wide ? " wide" : ""}`}
      onClick={() => void retry()}
      disabled={busy}
      title="정리에 실패한 메모만 다시 정리해요"
    >
      <RotateCw size={14} /> 실패한 {count}개 다시 정리
    </button>
  );
}
