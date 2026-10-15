import { Cloud, CloudOff, RefreshCw, TriangleAlert } from "lucide-react";

import { syncNow, useSyncState } from "../lib/sync";
import { relativeDate } from "../lib/ui";

export function SyncPill() {
  const sync = useSyncState();
  const view = {
    syncing: { icon: <RefreshCw size={14} className="spin" />, text: "동기화 중", tone: "busy" },
    idle: { icon: <Cloud size={14} />, text: "PC 연결됨", tone: "ok" },
    offline: { icon: <CloudOff size={14} />, text: "오프라인 · 이 기기에 저장", tone: "off" },
    error: { icon: <TriangleAlert size={14} />, text: "연결 오류", tone: "warn" },
  }[sync.phase];

  const title =
    sync.phase === "error"
      ? sync.error
      : sync.lastSyncAt
        ? `마지막 동기화 ${relativeDate(sync.lastSyncAt)} · 눌러서 지금 동기화`
        : "눌러서 지금 동기화";

  return (
    <button type="button" className={`sync-pill ${view.tone}`} onClick={() => void syncNow()} title={title}>
      {view.icon}
      <span>{view.text}</span>
    </button>
  );
}
