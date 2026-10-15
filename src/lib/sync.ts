import { useSyncExternalStore } from "react";

import { getMeta } from "./db";
import { refreshPushRegistration } from "./push";
import { ApiError, OfflineError } from "./serverApi";
import { LAST_SYNC_KEY, syncOnce } from "./syncCore";

export type SyncPhase = "idle" | "syncing" | "offline" | "error";

export interface SyncState {
  phase: SyncPhase;
  lastSyncAt: string;
  user: string;
  error: string;
  organizerBusy: boolean;
  llmReady: boolean;
  llmMessage: string;
}

let state: SyncState = {
  phase: "offline",
  lastSyncAt: "",
  user: "",
  error: "",
  organizerBusy: false,
  llmReady: false,
  llmMessage: "",
};
const listeners = new Set<() => void>();
let inflight: Promise<void> | null = null;
let onRemoteChange: () => void = () => {};
let pushRegistered = false;

function setState(patch: Partial<SyncState>) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

export function useSyncState(): SyncState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
  );
}

/** Registers what to do after the server's changes were written to the local database. */
export function setOnRemoteChange(handler: () => void) {
  onRemoteChange = handler;
}

async function run(): Promise<void> {
  setState({ phase: "syncing" });
  try {
    const { health, changed, lastSyncAt } = await syncOnce();
    setState({
      phase: "idle",
      lastSyncAt,
      error: "",
      user: health.user,
      organizerBusy: health.organizer.queued > 0 || health.organizer.running,
      llmReady: health.llm.ready,
      llmMessage: health.llm.message,
    });
    if (changed) onRemoteChange();
    // Keep the PC's list of wake-up targets fresh (a push subscription can be replaced by the browser).
    if (!pushRegistered) {
      pushRegistered = true;
      void refreshPushRegistration();
    }
  } catch (error) {
    if (error instanceof OfflineError) setState({ phase: "offline", error: "", organizerBusy: false });
    else if (error instanceof ApiError) setState({ phase: "error", error: error.message });
    else setState({ phase: "error", error: error instanceof Error ? error.message : String(error) });
  }
}

/** Runs one sync round. Concurrent calls share the same round. */
export function syncNow(): Promise<void> {
  if (!inflight) {
    inflight = run().finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

let debounce: number | undefined;
/** Called after every local change: sync soon, but batch bursts of edits. */
export function requestSync() {
  window.clearTimeout(debounce);
  debounce = window.setTimeout(() => void syncNow(), 800);
}

/**
 * Keeps devices converging: syncs on start, when the app regains focus or network, and on a timer
 * (faster while the server is still organizing something).
 */
export function startSyncLoop(isBusy: () => boolean): () => void {
  let timer: number | undefined;
  let stopped = false;

  const schedule = () => {
    window.clearTimeout(timer);
    if (stopped) return;
    const delay = isBusy() || state.organizerBusy ? 3000 : state.phase === "offline" ? 20_000 : 15_000;
    timer = window.setTimeout(async () => {
      if (document.visibilityState === "visible") await syncNow();
      schedule();
    }, delay);
  };

  const kick = () => {
    void syncNow().then(schedule);
  };
  const onVisible = () => {
    if (document.visibilityState === "visible") kick();
  };

  void getMeta<string>(LAST_SYNC_KEY).then((value) => {
    if (value && !state.lastSyncAt) setState({ lastSyncAt: value });
  });
  // The server announces every stored change; pull right away. A change that lands while a round is
  // already running is not part of it, so one more round follows.
  let events: EventSource | undefined;
  let eventTimer: number | undefined;
  const onServerChange = () => {
    window.clearTimeout(eventTimer);
    eventTimer = window.setTimeout(() => {
      if (document.visibilityState !== "visible") return;
      const running = inflight ?? Promise.resolve();
      void running.then(() => syncNow());
    }, 100);
  };
  if (typeof EventSource !== "undefined") {
    events = new EventSource("/api/events");
    events.addEventListener("changed", onServerChange);
  }

  window.addEventListener("online", kick);
  document.addEventListener("visibilitychange", onVisible);
  kick();

  return () => {
    stopped = true;
    window.clearTimeout(timer);
    window.clearTimeout(eventTimer);
    events?.close();
    window.removeEventListener("online", kick);
    document.removeEventListener("visibilitychange", onVisible);
  };
}
