import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App";
import { ErrorBoundary } from "./ErrorBoundary";
import { applyTheme, getTheme } from "./lib/ui";
import "./styles.css";
import "./library.css";

applyTheme(getTheme());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);

if ("serviceWorker" in navigator) {
  if (import.meta.env.PROD) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        // Without a service worker the app still works online; offline start-up is what is lost.
      });
    });
  } else {
    // A worker left over from a production build would serve stale files during development.
    void navigator.serviceWorker.getRegistrations().then((registrations) => registrations.forEach((entry) => void entry.unregister()));
  }
}
