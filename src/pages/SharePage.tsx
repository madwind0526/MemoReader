import { useEffect, useRef, useState } from "react";

import { addItem } from "../lib/library";
import { navigate, useLocation } from "../lib/router";
import { toast } from "../lib/ui";

/** Landing page for the OS share sheet (PWA share_target): saves the shared content, then opens it. */
export function SharePage() {
  const location = useLocation();
  const [message, setMessage] = useState("저장하는 중…");
  const handled = useRef("");

  useEffect(() => {
    // React StrictMode runs effects twice in development; one share must create one item.
    if (handled.current === location.key) return;
    handled.current = location.key;

    const title = location.params.get("title") ?? "";
    const text = location.params.get("text") ?? "";
    const url = location.params.get("url") ?? "";
    const parts = [title, text, url].map((part) => part.trim()).filter(Boolean);
    const unique = parts.filter((part, index) => parts.indexOf(part) === index);
    if (!unique.length) {
      setMessage("공유된 내용이 없어요.");
      window.setTimeout(() => navigate("/", { replace: true }), 1200);
      return;
    }

    void addItem({ text: unique.join("\n"), url, title: unique.length > 1 ? title : "", source: "share" })
      .then(({ item, duplicate, merged }) => {
        toast(duplicate ? (merged ? "이미 저장된 링크예요. 메모를 덧붙였어요" : "이미 저장된 링크예요") : "저장했어요");
        navigate(`/item/${item.id}`, { replace: true });
      })
      .catch(() => setMessage("저장하지 못했어요. 다시 시도해 주세요."));
  }, [location.key, location.params]);

  return (
    <div className="page narrow center">
      <p>{message}</p>
    </div>
  );
}
