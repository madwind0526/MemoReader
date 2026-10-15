import { BookOpen, FileUp, Moon, PlusCircle, Settings, Sun } from "lucide-react";
import { useEffect, useState } from "react";

import { CategoryMenu } from "./components/CategoryMenu";
import { Link } from "./components/Link";
import { SyncPill } from "./components/SyncPill";
import { addItem, deviceSource, useLibrary } from "./lib/library";
import { useIsDesktop } from "./lib/libraryView";
import { navigate, useLocation } from "./lib/router";
import { startSyncLoop } from "./lib/sync";
import { applyTheme, getTheme, toast, useToast } from "./lib/ui";
import { AddPage } from "./pages/AddPage";
import { ImportPage } from "./pages/ImportPage";
import { LibraryPage } from "./pages/LibraryPage";
import { SettingsPage } from "./pages/SettingsPage";
import { SharePage } from "./pages/SharePage";

const NAV = [
  { to: "/", label: "보관함", icon: BookOpen, match: (path: string) => path === "/" || path.startsWith("/item/") },
  { to: "/add", label: "저장", icon: PlusCircle, match: (path: string) => path === "/add" },
  { to: "/settings", label: "설정", icon: Settings, match: (path: string) => path === "/settings" },
];

// Import is a PC-only screen: it sits in the sidebar (under 저장), never in the phone's tab bar.
const IMPORT_NAV = { to: "/import", label: "가져오기", icon: FileUp, match: (path: string) => path === "/import" };

function isDark(): boolean {
  const choice = getTheme();
  return choice === "dark" || (choice === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
}

function PcOnlyPage() {
  return (
    <div className="page narrow">
      <h1 className="page-title">가져오기</h1>
      <div className="notice">가져오기는 PC 화면에서만 쓸 수 있어요. PC에서 열어 주세요.</div>
      <Link to="/" className="btn">
        보관함으로 돌아가기
      </Link>
    </div>
  );
}

export default function App() {
  const location = useLocation();
  const { items } = useLibrary();
  const message = useToast();
  const [dark, setDark] = useState(isDark);
  const desktop = useIsDesktop();

  const busy = items.some((item) => item.status === "pending" || item.status === "processing");
  useEffect(() => startSyncLoop(() => busy), [busy]);

  // Ctrl+V anywhere outside a text field saves the clipboard text (mainly for the PC).
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      const text = event.clipboardData?.getData("text/plain")?.trim();
      if (!text) return;
      event.preventDefault();
      void addItem({ text, source: deviceSource() }).then(({ item, duplicate, merged }) => {
        toast(duplicate ? (merged ? "이미 저장된 링크예요. 메모를 덧붙였어요" : "이미 저장된 링크예요") : "클립보드 내용을 저장했어요");
        if (location.path === "/") navigate(`/item/${item.id}`);
      });
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [location.path]);

  const toggleTheme = () => {
    const next = dark ? "light" : "dark";
    applyTheme(next);
    setDark(!dark);
  };

  const { path } = location;
  const itemMatch = /^\/item\/([^/]+)$/.exec(path);

  let page;
  if (path === "/add") page = <AddPage />;
  else if (path === "/import") page = desktop ? <ImportPage /> : <PcOnlyPage />;
  else if (path === "/settings") page = <SettingsPage />;
  else if (path === "/share") page = <SharePage />;
  else page = <LibraryPage selectedId={itemMatch ? decodeURIComponent(itemMatch[1]) : null} />;

  return (
    <div className="shell">
      <aside className="sidebar">
        <Link to="/" className="brand">
          <span className="brand-mark" aria-hidden="true" />
          MemoReader
        </Link>
        <nav aria-label="주 메뉴" className="side-nav">
          <CategoryMenu items={items} libraryActive={NAV[0].match(path)} />
          {[NAV[1], IMPORT_NAV, NAV[2]].map(({ to, label, icon: Icon, match }) => (
            <Link key={to} to={to} className={`nav-link${match(path) ? " active" : ""}`}>
              <Icon size={19} />
              <span>{label}</span>
            </Link>
          ))}
        </nav>
        <div className="sidebar-foot">
          <SyncPill />
          <button type="button" className="icon-btn" onClick={toggleTheme} aria-label="테마 전환">
            {dark ? <Sun size={18} /> : <Moon size={18} />}
          </button>
        </div>
      </aside>

      <header className="topbar">
        <Link to="/" className="brand">
          <span className="brand-mark" aria-hidden="true" />
          MemoReader
        </Link>
        <SyncPill />
      </header>

      <main className="content">{page}</main>

      <nav className="tabbar" aria-label="하단 메뉴">
        {NAV.map(({ to, label, icon: Icon, match }) => (
          <Link key={to} to={to} className={`tab${match(path) ? " active" : ""}`}>
            <Icon size={22} />
            <span>{label}</span>
          </Link>
        ))}
      </nav>

      {message.message && (
        <div className="toast" role="status" key={message.id}>
          {message.message}
        </div>
      )}
    </div>
  );
}
