import { useSyncExternalStore } from "react";

// ---- theme ----------------------------------------------------------------------------------

export type ThemeChoice = "system" | "light" | "dark";
const THEME_KEY = "memoreader.theme";

export function getTheme(): ThemeChoice {
  try {
    const value = localStorage.getItem(THEME_KEY);
    if (value === "light" || value === "dark") return value;
  } catch {
    // Storage can be blocked; fall back to the system theme.
  }
  return "system";
}

export function applyTheme(choice: ThemeChoice) {
  const root = document.documentElement;
  if (choice === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", choice);
  try {
    if (choice === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, choice);
  } catch {
    // Ignore: the choice still applies for this session.
  }
}

// ---- toast ----------------------------------------------------------------------------------

interface ToastState {
  id: number;
  message: string;
}

let toastState: ToastState = { id: 0, message: "" };
const toastListeners = new Set<() => void>();
let toastTimer: number | undefined;

export function toast(message: string) {
  toastState = { id: toastState.id + 1, message };
  for (const listener of toastListeners) listener();
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toastState = { id: toastState.id + 1, message: "" };
    for (const listener of toastListeners) listener();
  }, 2600);
}

export function useToast(): ToastState {
  return useSyncExternalStore(
    (listener) => {
      toastListeners.add(listener);
      return () => toastListeners.delete(listener);
    },
    () => toastState,
  );
}

// ---- formatting -----------------------------------------------------------------------------

export const SOURCE_LABELS: Record<string, string> = {
  mobile: "모바일",
  pc: "PC",
  telegram: "텔레그램",
  share: "공유",
  web: "웹",
  obsidian: "Obsidian",
  kakao: "카카오톡",
  file: "파일",
};

export const STATUS_LABELS: Record<string, string> = {
  pending: "정리 대기",
  processing: "정리 중",
  done: "정리 완료",
  failed: "정리 실패",
};

export function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("ko-KR", { year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function relativeDate(iso: string): string {
  const date = new Date(iso);
  const minutes = Math.round((Date.now() - date.getTime()) / 60000);
  if (Number.isNaN(minutes)) return "";
  if (minutes < 1) return "방금";
  if (minutes < 60) return `${minutes}분 전`;
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}시간 전`;
  if (minutes < 60 * 24 * 7) return `${Math.floor(minutes / (60 * 24))}일 전`;
  return date.toLocaleDateString("ko-KR", { year: "numeric", month: "numeric", day: "numeric" });
}

/** The memo's time for display: the original publish time when known, otherwise the time it was saved. */
export function memoTime(item: { publishedAt?: string; createdAt: string }): { label: string; title: string; original: boolean } {
  const published = item.publishedAt ?? "";
  const saved = `저장: ${formatDate(item.createdAt)}`;
  if (!published) return { label: relativeDate(item.createdAt), title: saved, original: false };
  const dayOnly = published.length === 10;
  // A date without a time is a calendar day; show it as written instead of shifting it by a time zone.
  const label = dayOnly
    ? new Date(`${published}T12:00:00`).toLocaleDateString("ko-KR", { year: "numeric", month: "numeric", day: "numeric" })
    : relativeDate(published);
  return { label, title: `원문: ${dayOnly ? label : formatDate(published)}\n${saved}`, original: true };
}

export type TextPart = { text: string } | { url: string };

/** Splits text into plain parts and http(s) links so links can be rendered without raw HTML. */
export function linkify(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let last = 0;
  for (const match of text.matchAll(/https?:\/\/[^\s<>"'`)\]}]+/gi)) {
    const index = match.index ?? 0;
    const url = match[0].replace(/[.,;:!?]+$/, "");
    if (index > last) parts.push({ text: text.slice(last, index) });
    parts.push({ url });
    last = index + url.length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}
