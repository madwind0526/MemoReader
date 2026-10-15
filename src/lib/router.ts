import { useMemo, useSyncExternalStore } from "react";

const NAVIGATE_EVENT = "memoreader:navigate";
// How many in-app pushes happened, so "back" never leaves the app when the page was opened directly.
let internalPushes = 0;

function subscribe(listener: () => void) {
  window.addEventListener("popstate", listener);
  window.addEventListener(NAVIGATE_EVENT, listener);
  return () => {
    window.removeEventListener("popstate", listener);
    window.removeEventListener(NAVIGATE_EVENT, listener);
  };
}

const snapshot = () => window.location.pathname + window.location.search;

export function navigate(to: string, options: { replace?: boolean } = {}) {
  if (options.replace) window.history.replaceState(null, "", to);
  else {
    window.history.pushState(null, "", to);
    internalPushes += 1;
  }
  window.dispatchEvent(new Event(NAVIGATE_EVENT));
}

export function goBack(fallback = "/") {
  if (internalPushes > 0) {
    internalPushes -= 1;
    window.history.back();
  } else {
    navigate(fallback, { replace: true });
  }
}

export function useLocation() {
  const key = useSyncExternalStore(subscribe, snapshot);
  return useMemo(() => {
    const url = new URL(key, window.location.origin);
    return { key, path: url.pathname, params: url.searchParams, search: url.search };
  }, [key]);
}
