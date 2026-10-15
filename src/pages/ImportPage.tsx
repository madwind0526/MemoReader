import { FileUp, Sparkles } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { FORMAT_LABELS, parseImportFile } from "../../shared/import-text.mjs";
import { classifyMessage, snippet } from "../../shared/kakao.mjs";
import { extractFirstUrl } from "../../shared/item.mjs";
import { api } from "../lib/serverApi";
import { importItems, useLibrary } from "../lib/library";
import { navigate } from "../lib/router";
import { toast } from "../lib/ui";

type Kind = "link" | "long" | "short" | "system";

interface Message {
  index: number;
  at: Date;
  text: string;
  year: number;
  link: string;
  title: string;
  /** Which file it came from and how that file was recognized. */
  file: string;
  format: string;
  /** The file gave no date, so the file's own date stands in. */
  undated: boolean;
}

interface LoadedFile {
  name: string;
  format: string;
  count: number;
}

const KIND_LABELS: Record<Kind, string> = { link: "링크", long: "긴 글", short: "짧은 글", system: "사진·삭제" };
const LONG_CHOICES = [100, 150, 300, 500];
const SHOW_STEP = 100;
const AI_BATCH = 25;

const formatDay = (date: Date) => date.toLocaleDateString("ko-KR", { year: "numeric", month: "numeric", day: "numeric" });

/** Import screen (PC only): read files (a KakaoTalk export, text or Markdown notes, blog backups), screen out what is not worth keeping, then save the rest as memos. */
export function ImportPage() {
  const { items } = useLibrary();
  const fileInput = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<LoadedFile[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [error, setError] = useState("");

  const [withLinks, setWithLinks] = useState(true);
  const [withLong, setWithLong] = useState(true);
  const [withShort, setWithShort] = useState(false);
  const [skipSaved, setSkipSaved] = useState(true);
  const [longChars, setLongChars] = useState(150);
  const [years, setYears] = useState<Set<number>>(new Set());
  const [aiExclude, setAiExclude] = useState(true);
  const [ai, setAi] = useState<Map<number, boolean>>(new Map());
  const [aiProgress, setAiProgress] = useState<{ done: number; total: number } | null>(null);
  const [overrides, setOverrides] = useState<Map<number, boolean>>(new Map());
  const [shown, setShown] = useState(SHOW_STEP);
  const [saving, setSaving] = useState(false);

  const savedUrls = useMemo(() => new Set(items.map((item) => item.url).filter(Boolean)), [items]);

  async function readFiles(chosen: File[]) {
    setError("");
    try {
      const list: Message[] = [];
      const loaded: LoadedFile[] = [];
      const skipped: string[] = [];
      for (const file of chosen) {
        const parsed = parseImportFile({ name: file.name, text: await file.text() }) as { format: string; entries: Array<{ at: Date | null; text: string; title: string }> };
        if (!parsed.entries.length) {
          skipped.push(file.name);
          continue;
        }
        loaded.push({ name: file.name, format: parsed.format, count: parsed.entries.length });
        for (const entry of parsed.entries) {
          const at = entry.at ?? new Date(file.lastModified);
          list.push({ index: list.length, at, text: entry.text, year: at.getFullYear(), link: extractFirstUrl(entry.text), title: entry.title, file: file.name, format: parsed.format, undated: !entry.at });
        }
      }
      if (!list.length) throw new Error("읽을 수 있는 글을 찾지 못했어요. 카카오톡 대화 내보내기, 텍스트·마크다운, 블로그 백업(HTML·XML), JSON 파일을 골라 주세요.");
      list.sort((a, b) => a.at.getTime() - b.at.getTime());
      list.forEach((message, index) => {
        message.index = index;
      });
      setMessages(list);
      setFiles(loaded);
      setYears(new Set(list.map((message) => message.year)));
      setAi(new Map());
      setOverrides(new Map());
      setShown(SHOW_STEP);
      if (skipped.length) setError(`글을 찾지 못해 건너뛴 파일: ${skipped.slice(0, 3).join(", ")}${skipped.length > 3 ? ` 외 ${skipped.length - 3}개` : ""}`);
    } catch (problem) {
      setMessages([]);
      setFiles([]);
      setError(problem instanceof Error ? problem.message : "파일을 읽지 못했어요.");
    }
  }

  /** A chat message is sorted by the chat rules; an article is "long" by length alone, even when it mentions an address. */
  function kindFor(message: Message, chars: number): Kind {
    if (message.format === "kakao") return classifyMessage(message.text, chars) as Kind;
    if (message.text.length >= chars) return "long";
    return message.link ? "link" : "short";
  }
  const kindOf = (message: Message): Kind => kindFor(message, longChars);
  const allYears = useMemo(() => [...new Set(messages.map((message) => message.year))].sort(), [messages]);

  /** Whether the screening buttons let this message through, before any manual tick or untick. */
  function passes(message: Message): boolean {
    if (!years.has(message.year)) return false;
    const kind = kindOf(message);
    if (kind === "system") return false;
    if (kind === "link") return withLinks && !(skipSaved && savedUrls.has(message.link));
    if (kind === "long") return withLong && !(aiExclude && ai.get(message.index) === false);
    return withShort;
  }

  const isSelected = (message: Message) => overrides.get(message.index) ?? passes(message);
  // The candidate list: everything that passes, plus anything the user ticked or unticked by hand.
  const candidates = messages.filter((message) => passes(message) || overrides.has(message.index)).sort((a, b) => b.at.getTime() - a.at.getTime());
  const selected = candidates.filter(isSelected);

  const counts = useMemo(() => {
    const result: Record<Kind, number> = { link: 0, long: 0, short: 0, system: 0 };
    for (const message of messages) result[kindFor(message, longChars)] += 1;
    return result;
  }, [messages, longChars]);

  function toggleOverride(message: Message, checked: boolean) {
    setOverrides((current) => {
      const next = new Map(current);
      if (checked === passes(message)) next.delete(message.index);
      else next.set(message.index, checked);
      return next;
    });
  }

  function setAll(checked: boolean) {
    setOverrides((current) => {
      const next = new Map(current);
      for (const message of candidates) {
        if (checked === passes(message)) next.delete(message.index);
        else next.set(message.index, checked);
      }
      return next;
    });
  }

  async function screenWithAi() {
    const targets = messages.filter((message) => years.has(message.year) && kindOf(message) === "long" && !ai.has(message.index));
    if (!targets.length) {
      toast("판단할 긴 글이 없어요");
      return;
    }
    setError("");
    setAiProgress({ done: 0, total: targets.length });
    const next = new Map(ai);
    try {
      for (let start = 0; start < targets.length; start += AI_BATCH) {
        const batch = targets.slice(start, start + AI_BATCH);
        const answer = await api<{ ok: boolean; keep?: boolean[]; message?: string }>("/api/import/screen", {
          method: "POST",
          body: { texts: batch.map((message) => message.text.slice(0, 400)) },
          timeoutMs: 180_000,
        });
        if (!answer.ok || !answer.keep) throw new Error(answer.message || "판단에 실패했어요.");
        batch.forEach((message, index) => next.set(message.index, answer.keep![index] === true));
        setAi(new Map(next));
        setAiProgress({ done: Math.min(start + AI_BATCH, targets.length), total: targets.length });
      }
      setAiExclude(true);
      toast("일상 메모를 걸러냈어요. 목록에서 다시 확인해 보세요");
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "판단에 실패했어요.");
    } finally {
      setAiProgress(null);
    }
  }

  async function save() {
    if (!selected.length) return;
    setSaving(true);
    try {
      // Chats and files are saved separately so each keeps its own source label.
      const toEntries = (list: Message[]) =>
        list.map((message) => ({
          text: message.text,
          at: message.at,
          sourceRef: `${message.format === "kakao" ? "kakao" : "file"}:${message.file.slice(0, 30)}:${message.at.toISOString().slice(0, 16)}:${message.index}`,
          title: message.title,
          // An article is kept as it is; only chat messages and short notes get a page fetched from an address in them.
          ...(message.format !== "kakao" && kindOf(message) === "long" ? { url: "" } : {}),
        }));
      const chats = await importItems(toEntries(selected.filter((message) => message.format === "kakao")), "kakao");
      const documents = await importItems(toEntries(selected.filter((message) => message.format !== "kakao")), "file");
      const created = chats.created + documents.created;
      const merged = chats.merged + documents.merged;
      toast(`${created}개를 저장했어요${merged ? ` (같은 링크 ${merged}개는 합쳤어요)` : ""}. PC가 한 건씩 정리해요`);
      navigate("/");
    } finally {
      setSaving(false);
    }
  }

  const aiDone = ai.size;

  return (
    <div className="page import-page">
      <h1 className="page-title">가져오기</h1>
      <p className="muted">
        글이 담긴 파일을 골라 저장할 만한 글만 메모로 가져와요. 카카오톡 "나와의 채팅" 내보내기(.txt), 텍스트·마크다운 노트(.txt, .md), 블로그 백업(.html, .xml), JSON 파일을 읽고, 여러 파일을 한꺼번에 고를 수도 있어요. 글을 쓴 날짜가 메모의 날짜가 되고(날짜가 없으면 파일 날짜), 정리는 PC가 한 건씩 진행해요.
      </p>

      <div className="import-pick">
        <input
          ref={fileInput}
          type="file"
          accept=".txt,.md,.markdown,.html,.htm,.xml,.json,text/*,application/json"
          multiple
          hidden
          onChange={(event) => {
            const chosen = Array.from(event.target.files ?? []);
            if (chosen.length) void readFiles(chosen);
            event.target.value = "";
          }}
        />
        <button type="button" className="btn primary" onClick={() => fileInput.current?.click()}>
          <FileUp size={17} /> 파일 선택
        </button>
        {files.length > 0 && (
          <span className="muted">
            {files.length === 1 ? files[0].name : `파일 ${files.length}개`} ({[...new Set(files.map((file) => FORMAT_LABELS[file.format as keyof typeof FORMAT_LABELS] ?? file.format))].join(", ")}) · 글 {messages.length.toLocaleString("ko-KR")}개 ({formatDay(messages[0].at)} ~ {formatDay(messages[messages.length - 1].at)})
          </span>
        )}
      </div>

      {error && <div className="notice warn">{error}</div>}

      {messages.length > 0 && (
        <>
          <section className="import-filters" aria-label="걸러내기">
            <h2>걸러내기</h2>
            <div className="import-chips">
              <button type="button" className={`chip${withLinks ? " active" : ""}`} aria-pressed={withLinks} onClick={() => setWithLinks(!withLinks)}>
                링크 {counts.link}
              </button>
              <button type="button" className={`chip${withLong ? " active" : ""}`} aria-pressed={withLong} onClick={() => setWithLong(!withLong)}>
                긴 글 {counts.long}
              </button>
              <button type="button" className={`chip${withShort ? " active" : ""}`} aria-pressed={withShort} onClick={() => setWithShort(!withShort)}>
                짧은 글 {counts.short}
              </button>
              <button type="button" className={`chip${skipSaved ? " active" : ""}`} aria-pressed={skipSaved} onClick={() => setSkipSaved(!skipSaved)}>
                이미 저장한 링크 제외
              </button>
              <label className="import-select">
                긴 글 기준
                <select value={longChars} onChange={(event) => setLongChars(Number(event.target.value))} aria-label="긴 글 최소 글자 수">
                  {LONG_CHOICES.map((value) => (
                    <option key={value} value={value}>
                      {value}자 이상
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="import-chips">
              <span className="muted">연도</span>
              {allYears.map((year) => (
                <button
                  key={year}
                  type="button"
                  className={`chip small${years.has(year) ? " active" : ""}`}
                  aria-pressed={years.has(year)}
                  onClick={() => setYears((current) => (current.has(year) ? new Set([...current].filter((value) => value !== year)) : new Set([...current, year])))}
                >
                  {year}
                </button>
              ))}
            </div>

            <div className="import-chips">
              <button type="button" className="btn small" onClick={() => void screenWithAi()} disabled={aiProgress !== null}>
                <Sparkles size={15} /> {aiProgress ? `AI가 판단 중… ${aiProgress.done}/${aiProgress.total}` : "AI로 일상 메모 걸러내기"}
              </button>
              {aiDone > 0 && (
                <button type="button" className={`chip${aiExclude ? " active" : ""}`} aria-pressed={aiExclude} onClick={() => setAiExclude(!aiExclude)}>
                  AI가 일상 메모로 본 글 제외 ({[...ai.values()].filter((keep) => !keep).length})
                </button>
              )}
            </div>
            <p className="muted import-hint">
              긴 글 중 가족·이웃 이야기, 할 일처럼 일상적인 내용은 AI가 걸러 줘요. 카카오톡의 사진·이모티콘·삭제된 메시지는 항상 빠져요. 파일에 날짜가 없는 글은 파일 날짜로 저장돼요. 아래 목록에서 하나씩 체크를 바꿀 수도 있어요.
            </p>
          </section>

          <section className="import-list" aria-label="가져올 목록">
            <div className="import-list-head">
              <h2>
                가져올 메모 <strong>{selected.length}</strong>개 <span className="muted">/ 후보 {candidates.length}개</span>
              </h2>
              <span className="import-list-actions">
                <button type="button" className="btn small" onClick={() => setAll(true)}>
                  전체 선택
                </button>
                <button type="button" className="btn small" onClick={() => setAll(false)}>
                  전체 해제
                </button>
              </span>
            </div>
            <ul>
              {candidates.slice(0, shown).map((message) => {
                const kind = kindOf(message);
                const checked = isSelected(message);
                return (
                  <li key={message.index} className={checked ? "" : "off"}>
                    <label>
                      <input type="checkbox" checked={checked} onChange={(event) => toggleOverride(message, event.target.checked)} />
                      <span className={`badge import-kind ${kind}`}>{KIND_LABELS[kind]}</span>
                      <span className="import-date muted">{formatDay(message.at)}</span>
                      <span className="import-text">{snippet(message.text)}</span>
                    </label>
                  </li>
                );
              })}
            </ul>
            {shown < candidates.length && (
              <button type="button" className="btn small" onClick={() => setShown(shown + SHOW_STEP)}>
                더 보기 ({candidates.length - shown}개 남음)
              </button>
            )}
            {!candidates.length && <p className="muted">선택한 조건에 맞는 글이 없어요. 위의 버튼으로 조건을 바꿔 보세요.</p>}
          </section>

          <div className="import-save">
            <button type="button" className="btn primary" onClick={() => void save()} disabled={saving || !selected.length}>
              {saving ? "저장 중…" : `${selected.length}개 가져오기`}
            </button>
            <span className="muted">같은 링크는 하나로 합쳐지고, 원문은 그대로 보관돼요.</span>
          </div>
        </>
      )}
    </div>
  );
}
