import { CheckCircle2, CircleAlert, Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { useLibrary } from "../lib/library";
import {
  disablePush,
  enablePush,
  getPushAvailability,
  lastPushAt,
  lastPushError,
  lastPushSyncError,
  notificationPermission,
  sendTestPush,
  type PushAvailability,
} from "../lib/push";
import { ApiError, OfflineError, api } from "../lib/serverApi";
import { syncNow, useSyncState } from "../lib/sync";
import { applyTheme, formatDate, getTheme, toast, type ThemeChoice } from "../lib/ui";
import type { ServerSettings, ServerStatus } from "../types";

const PROVIDERS: Array<{ id: string; label: string; needsKey: boolean; needsEndpoint: boolean; modelHint: string }> = [
  { id: "none", label: "사용 안 함 (정리하지 않음)", needsKey: false, needsEndpoint: false, modelHint: "" },
  { id: "claude-cli", label: "Claude CLI (PC에 로그인된 claude 명령)", needsKey: false, needsEndpoint: false, modelHint: "비워 두면 CLI 기본 모델" },
  { id: "codex-cli", label: "Codex CLI", needsKey: false, needsEndpoint: false, modelHint: "비워 두면 CLI 기본 모델" },
  { id: "opencode-cli", label: "OpenCode CLI", needsKey: false, needsEndpoint: false, modelHint: "비워 두면 CLI 기본 모델" },
  { id: "ollama", label: "Ollama (PC 로컬)", needsKey: false, needsEndpoint: true, modelHint: "예: llama3.1" },
  { id: "anthropic", label: "Claude API", needsKey: true, needsEndpoint: false, modelHint: "예: claude-sonnet-5-5" },
  { id: "openai", label: "OpenAI API", needsKey: true, needsEndpoint: false, modelHint: "모델 이름" },
  { id: "gemini", label: "Gemini API", needsKey: true, needsEndpoint: false, modelHint: "예: gemini-2.5-flash" },
];

interface SettingsResponse extends ServerStatus {
  settings: ServerSettings;
}

interface Form {
  provider: string;
  endpoint: string;
  model: string;
  apiKey: string;
  clearApiKey: boolean;
  fallback: boolean;
  ollamaModel: string;
  summaryLines: number;
  maxTags: number;
  render: boolean;
  useLogin: boolean;
  tgEnabled: boolean;
  botToken: string;
  clearBotToken: boolean;
  chatIds: string;
  logins: string;
}

function toForm(settings: ServerSettings): Form {
  return {
    provider: settings.llm.provider,
    endpoint: settings.llm.endpoint,
    model: settings.llm.model,
    apiKey: "",
    clearApiKey: false,
    fallback: settings.llm.fallback,
    ollamaModel: settings.llm.ollamaModel,
    summaryLines: settings.organize.summaryLines,
    maxTags: settings.organize.maxTags,
    render: settings.organize.render,
    useLogin: settings.organize.useLogin,
    tgEnabled: settings.telegram.enabled,
    botToken: "",
    clearBotToken: false,
    chatIds: settings.telegram.allowedChatIds.join(", "),
    logins: settings.auth.allowedLogins.join(", "),
  };
}

/** Saved login cookies for the browser reader: pick a cookies.txt, see where a login is saved, switch use on or off. */
function LoginCookies({ useLogin, onUseLogin }: { useLogin: boolean; onUseLogin: (value: boolean) => void }) {
  const [status, setStatus] = useState<{ saved: boolean; savedAt: string; count: number; sites: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const picker = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api<{ saved: boolean; savedAt: string; count: number; sites: string[] }>("/api/cookies").then(setStatus, () => setStatus(null));
  }, []);

  async function upload(file: File) {
    setBusy(true);
    try {
      setStatus(await api("/api/cookies", { method: "PUT", body: { text: await file.text() }, timeoutMs: 30_000 }));
      toast("쿠키 파일을 저장했어요");
    } catch (error) {
      toast(error instanceof Error ? error.message : "쿠키 파일을 저장하지 못했어요");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      setStatus(await api("/api/cookies", { method: "DELETE" }));
      onUseLogin(false);
      toast("저장된 쿠키를 지웠어요");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="notice">
      <strong>로그인 쿠키 (선택)</strong>
      <p className="muted">
        브라우저에서 내보낸 cookies.txt를 고르면 이 PC의 data 폴더에 저장돼요. 켜면 Facebook·Instagram 같은 사이트를 열 때 그 사이트의 쿠키만 쓰고, 같은 사이트는 몇 초 간격을 두고 읽어요. 사이트에 따라 글 대신 홈 화면이 나오거나 로그인이 거부될 수 있어서 기본은 꺼져 있어요. 쿠키는 계정 열쇠라서 다른 곳에 공유하지 마세요.
      </p>
      <input
        ref={picker}
        type="file"
        accept=".txt,text/plain"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void upload(file);
          event.target.value = "";
        }}
      />
      <div className="row">
        <button type="button" className="btn small" onClick={() => picker.current?.click()} disabled={busy}>
          쿠키 파일 선택
        </button>
        {status?.saved && (
          <button type="button" className="btn small" onClick={() => void remove()} disabled={busy}>
            지우기
          </button>
        )}
      </div>
      {status?.saved ? (
        <p className="muted">
          저장됨 · 쿠키 {status.count}개 · {formatDate(status.savedAt)}
          {status.sites.length ? ` · 로그인된 사이트: ${status.sites.join(", ")}` : " · 로그인 쿠키가 있는 사이트 없음"}
        </p>
      ) : (
        <p className="muted">저장된 쿠키 파일이 없어요.</p>
      )}
      <label className="check">
        <input type="checkbox" checked={useLogin} disabled={!status?.saved} onChange={(event) => onUseLogin(event.target.checked)} />
        브라우저로 읽을 때 로그인 쿠키 사용
      </label>
    </div>
  );
}

export function SettingsPage() {
  const sync = useSyncState();
  const { items } = useLibrary();
  const [theme, setTheme] = useState<ThemeChoice>(getTheme());
  const [loaded, setLoaded] = useState<SettingsResponse | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [offline, setOffline] = useState(false);
  const [problem, setProblem] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [pushState, setPushState] = useState<PushAvailability | null>(null);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushedAt, setPushedAt] = useState("");
  const [pushError, setPushError] = useState("");
  const [pushSyncError, setPushSyncError] = useState("");

  const loadPush = useCallback(async () => {
    setPushState(await getPushAvailability());
    setPushedAt((await lastPushAt()) ?? "");
    setPushError((await lastPushError()) ?? "");
    setPushSyncError((await lastPushSyncError()) ?? "");
  }, []);

  useEffect(() => {
    void loadPush();
  }, [loadPush]);

  const runPush = async (task: () => Promise<unknown>, done: string) => {
    setPushBusy(true);
    try {
      await task();
      toast(done);
    } catch (error) {
      toast(error instanceof Error ? error.message : "처리하지 못했어요");
    } finally {
      setPushBusy(false);
      void loadPush();
    }
  };

  const load = useCallback(async () => {
    try {
      const response = await api<SettingsResponse>("/api/settings");
      setLoaded(response);
      setForm(toForm(response.settings));
      setOffline(false);
      setProblem("");
    } catch (error) {
      setOffline(error instanceof OfflineError);
      setProblem(error instanceof ApiError ? error.message : "");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const provider = PROVIDERS.find((entry) => entry.id === form?.provider) ?? PROVIDERS[0];
  const patch = (changes: Partial<Form>) => setForm((current) => (current ? { ...current, ...changes } : current));

  const save = async () => {
    if (!form) return;
    setSaving(true);
    try {
      const response = await api<SettingsResponse>("/api/settings", {
        method: "PUT",
        body: {
          llm: {
            provider: form.provider,
            endpoint: form.endpoint,
            model: form.model,
            apiKey: form.apiKey,
            clearApiKey: form.clearApiKey,
            fallback: form.fallback,
            ollamaModel: form.ollamaModel,
          },
          organize: { summaryLines: form.summaryLines, maxTags: form.maxTags, render: form.render, useLogin: form.useLogin },
          telegram: {
            enabled: form.tgEnabled,
            botToken: form.botToken,
            clearBotToken: form.clearBotToken,
            allowedChatIds: form.chatIds,
          },
          auth: { allowedLogins: form.logins },
        },
      });
      setLoaded(response);
      setForm(toForm(response.settings));
      setTestResult(null);
      toast("설정을 저장했어요");
    } catch (error) {
      toast(error instanceof Error ? error.message : "저장하지 못했어요");
    } finally {
      setSaving(false);
    }
  };

  const testLlm = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await api<{ ok: boolean; message: string }>("/api/llm/test", { method: "POST", body: {}, timeoutMs: 200_000 }));
    } catch (error) {
      setTestResult({ ok: false, message: error instanceof Error ? error.message : "테스트에 실패했어요" });
    } finally {
      setTesting(false);
    }
  };

  const pending = items.filter((item) => item.status !== "done").length;

  return (
    <div className="page">
      <h1 className="page-title">설정</h1>

      <section className="panel">
        <h2>연결</h2>
        <dl className="kv">
          <dt>PC 서버</dt>
          <dd>
            {sync.phase === "offline" ? "연결되지 않음 (이 기기에만 저장 중)" : sync.phase === "error" ? `오류: ${sync.error}` : `연결됨 (${sync.user})`}
          </dd>
          <dt>마지막 동기화</dt>
          <dd>{sync.lastSyncAt ? formatDate(sync.lastSyncAt) : "아직 없음"}</dd>
          <dt>이 기기의 항목</dt>
          <dd>
            {items.length.toLocaleString("ko-KR")}개{pending > 0 ? ` (정리 대기 ${pending}개)` : ""}
          </dd>
        </dl>
        <div className="row">
          <button type="button" className="btn" onClick={() => void syncNow().then(load)} disabled={sync.phase === "syncing"}>
            지금 동기화
          </button>
        </div>
        <p className="muted small-text">
          폰에서는 Tailscale로 PC에 연결되어 있을 때만 정리·동기화가 이뤄져요. 연결이 없어도 저장과 보기는 그대로 동작해요.
        </p>
      </section>

      <section className="panel">
        <h2>화면</h2>
        <div className="seg" role="radiogroup" aria-label="테마">
          {(["system", "light", "dark"] as const).map((choice) => (
            <button
              type="button"
              key={choice}
              role="radio"
              aria-checked={theme === choice}
              className={theme === choice ? "active" : ""}
              onClick={() => {
                setTheme(choice);
                applyTheme(choice);
              }}
            >
              {{ system: "시스템", light: "라이트", dark: "다크" }[choice]}
            </button>
          ))}
        </div>
      </section>

      {!form && (
        <section className="panel">
          <h2>PC 서버 설정</h2>
          <div className="notice">
            {offline
              ? "PC 서버에 연결되면 LLM, 텔레그램 등 서버 설정을 바꿀 수 있어요."
              : problem || "설정을 불러오는 중…"}
          </div>
        </section>
      )}

      {form && loaded && (
        <>
          <section className="panel">
            <h2>자동 정리 (LLM)</h2>
            <label>
              제공업체
              <select value={form.provider} onChange={(event) => patch({ provider: event.target.value, clearApiKey: false })}>
                {PROVIDERS.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.label}
                  </option>
                ))}
              </select>
            </label>
            {form.provider !== "none" && (
              <>
                <label>
                  모델
                  <input value={form.model} placeholder={provider.modelHint} onChange={(event) => patch({ model: event.target.value })} />
                </label>
                {(provider.needsEndpoint || provider.needsKey) && (
                  <label>
                    연결 주소 {provider.needsKey ? "(비워 두면 기본 주소)" : ""}
                    <input
                      value={form.endpoint}
                      placeholder={form.provider === "ollama" ? "http://127.0.0.1:11434" : "기본 주소 사용"}
                      onChange={(event) => patch({ endpoint: event.target.value })}
                    />
                  </label>
                )}
                {provider.needsKey && (
                  <label>
                    API 키 {loaded.settings.llm.hasApiKey && !form.clearApiKey ? "(저장됨 — 바꾸려면 새로 입력)" : ""}
                    <input
                      type="password"
                      autoComplete="off"
                      value={form.apiKey}
                      placeholder={loaded.settings.llm.hasApiKey ? "••••••••" : "API 키 입력"}
                      onChange={(event) => patch({ apiKey: event.target.value, clearApiKey: false })}
                    />
                  </label>
                )}
                {provider.needsKey && loaded.settings.llm.hasApiKey && (
                  <label className="check">
                    <input type="checkbox" checked={form.clearApiKey} onChange={(event) => patch({ clearApiKey: event.target.checked })} />
                    저장된 API 키 삭제
                  </label>
                )}
                {provider.id.endsWith("-cli") && (
                  <p className="muted small-text">
                    CLI 방식은 저장된 링크의 본문을 CLI에 그대로 전달해요. Claude CLI는 도구(파일·명령 실행)와 확장 기능을 모두 끈 채로 호출하므로
                    페이지 내용이 무엇을 실행할 수는 없어요. 다른 CLI는 그렇게 제한하지 못하니 신뢰할 수 없는 페이지가 많다면 API 방식을 권장해요.
                  </p>
                )}
              </>
            )}
            {form.provider !== "none" && (
              <>
                <label className="check">
                  <input type="checkbox" checked={form.fallback} onChange={(event) => patch({ fallback: event.target.checked })} />
                  실패하면 다른 방식으로 자동 전환 (Claude CLI → Codex CLI → OpenCode CLI → Ollama 순서)
                </label>
                {form.fallback && (
                  <label>
                    Ollama 모델 (마지막 순서에서 쓸 모델)
                    <input
                      value={form.ollamaModel}
                      placeholder="비워 두면 설치된 모델 중에서 자동으로 골라요"
                      onChange={(event) => patch({ ollamaModel: event.target.value })}
                    />
                  </label>
                )}
                {loaded.llmStatus.chain && loaded.llmStatus.chain.length > 0 && (
                  <ol className="chain" aria-label="정리 방식 순서">
                    {loaded.llmStatus.chain.map((entry, index) => (
                      <li key={entry.provider} className={entry.state}>
                        <span className="chain-step">{index + 1}</span>
                        <strong>{entry.label}</strong>
                        <span className="muted">{entry.note}</span>
                      </li>
                    ))}
                  </ol>
                )}
              </>
            )}
            <div className="grid-2">
              <label>
                요약 줄 수
                <input type="number" min={1} max={10} value={form.summaryLines} onChange={(event) => patch({ summaryLines: Number(event.target.value) })} />
              </label>
              <label>
                최대 태그 수
                <input type="number" min={1} max={15} value={form.maxTags} onChange={(event) => patch({ maxTags: Number(event.target.value) })} />
              </label>
            </div>
            <label className="check">
              <input type="checkbox" checked={form.render} onChange={(event) => patch({ render: event.target.checked })} />
              글이 거의 읽히지 않는 페이지는 브라우저로 열어서 읽기 (Chrome 또는 Edge 필요, 한 건에 몇 초 더 걸려요)
            </label>
            {form.render && <LoginCookies useLogin={form.useLogin} onUseLogin={(value) => patch({ useLogin: value })} />}
            <div className="row">
              <button type="button" className="btn" onClick={() => void testLlm()} disabled={testing || form.provider === "none"}>
                {testing ? <Loader2 size={16} className="spin" /> : null} 연결 테스트
              </button>
              <span className={`status-line ${loaded.llmStatus.ready ? "ok" : "off"}`}>
                {loaded.llmStatus.ready ? <CheckCircle2 size={15} /> : <CircleAlert size={15} />}
                {loaded.llmStatus.message}
              </span>
            </div>
            {testResult && <div className={`notice ${testResult.ok ? "" : "warn"}`}>{testResult.message}</div>}
            <p className="muted small-text">테스트하기 전에 아래의 저장 버튼으로 먼저 저장해 주세요.</p>
          </section>

          <section className="panel">
            <h2>저장 위치 (Obsidian)</h2>
            <p className="muted small-text">
              메모는 아래 폴더에 카테고리별 폴더로 나뉘어 Markdown 파일로 저장돼요. 이 폴더를 Obsidian에서 “폴더를 보관소로 열기”로 열면 그대로 볼 수 있어요.
              폴더를 바꾸려면 PC의 <code>.env</code> 파일에 <code>VAULT_DIR</code>를 적고 서버를 다시 시작하세요.
            </p>
            <code className="path-box">{loaded.storage.vaultDir}</code>
            <p className="muted small-text">
              Obsidian에서 메모를 직접 고치면 앱의 같은 메모를 수정할 때 덮어써질 수 있어요. 고치는 일은 앱에서 하고 Obsidian은 보고 찾는 용도로 쓰는 것을 권해요.
            </p>
          </section>

          <section className="panel">
            <h2>텔레그램 봇</h2>
            <label className="check">
              <input type="checkbox" checked={form.tgEnabled} onChange={(event) => patch({ tgEnabled: event.target.checked })} />
              봇으로 저장 받기
            </label>
            <label>
              봇 토큰 {loaded.settings.telegram.hasBotToken && !form.clearBotToken ? "(저장됨 — 바꾸려면 새로 입력)" : ""}
              <input
                type="password"
                autoComplete="off"
                value={form.botToken}
                placeholder={loaded.settings.telegram.hasBotToken ? "••••••••" : "BotFather에서 받은 토큰"}
                onChange={(event) => patch({ botToken: event.target.value, clearBotToken: false })}
              />
            </label>
            {loaded.settings.telegram.hasBotToken && (
              <label className="check">
                <input type="checkbox" checked={form.clearBotToken} onChange={(event) => patch({ clearBotToken: event.target.checked })} />
                저장된 봇 토큰 삭제
              </label>
            )}
            <label>
              허용할 채팅 ID (쉼표로 구분)
              <input value={form.chatIds} placeholder="봇에게 /id 를 보내면 알려줘요" onChange={(event) => patch({ chatIds: event.target.value })} />
            </label>
            <p className={`status-line ${loaded.telegramStatus.state === "ok" ? "ok" : loaded.telegramStatus.state === "error" ? "warn" : "off"}`}>
              {loaded.telegramStatus.state === "ok" && `연결됨 (@${loaded.telegramStatus.username})`}
              {loaded.telegramStatus.state === "error" && `오류: ${loaded.telegramStatus.error}`}
              {loaded.telegramStatus.state === "off" && "꺼져 있음"}
            </p>
          </section>

          <section className="panel">
            <h2>접근 허용</h2>
            <label>
              허용할 Tailscale 계정 (쉼표로 구분, 비워 두면 내 tailnet 전체)
              <input value={form.logins} placeholder="me@example.com" onChange={(event) => patch({ logins: event.target.value })} />
            </label>
            <p className="muted small-text">PC에서 직접 접속(127.0.0.1)하는 경우는 항상 허용돼요.</p>
          </section>

          <div className="save-bar">
            <button type="button" className="btn primary" onClick={() => void save()} disabled={saving}>
              {saving ? <Loader2 size={16} className="spin" /> : null} 서버 설정 저장
            </button>
          </div>
        </>
      )}

      <section className="panel">
        <h2>밀린 메모 자동 동기화 (알림)</h2>
        <p className="muted small-text">
          PC가 켜지면 이 기기에 알림이 오고, 앱이 닫혀 있어도 쌓인 메모가 PC로 올라가요. PC가 정리를 마치면 한 번 더 알려 주고 정리된 결과를 받아 와요.
          폰에서 Tailscale이 켜져 있어야 해요.
        </p>
        {pushState === "unsupported" && <div className="notice">이 브라우저는 푸시 알림을 지원하지 않아요. (iPhone은 홈 화면에 설치한 앱에서만 가능해요)</div>}
        {pushState === "no-worker" && <div className="notice">설치된(빌드된) 앱에서만 켤 수 있어요. 개발 모드에서는 사용할 수 없어요.</div>}
        {pushState === "blocked" && <div className="notice warn">알림이 차단되어 있어요. 브라우저의 사이트 설정에서 알림을 허용해 주세요.</div>}
        {pushState === "off" && (
          <div className="row">
            <button type="button" className="btn primary" disabled={pushBusy} onClick={() => void runPush(enablePush, "알림을 켰어요")}>
              이 기기에서 알림 켜기
            </button>
          </div>
        )}
        {pushState === "on" && (
          <>
            <p className="status-line ok">
              <CheckCircle2 size={15} /> 이 기기에서 켜져 있어요
            </p>
            <div className="row">
              <button
                type="button"
                className="btn"
                disabled={pushBusy}
                onClick={() =>
                  void runPush(async () => {
                    const result = await sendTestPush();
                    if (result.sent === 0) throw new Error("푸시 서비스가 받아 주지 않았어요. 알림을 껐다가 다시 켜 보세요.");
                  }, "푸시 서비스가 테스트 알림을 받았어요. 잠시 뒤 알림이 오는지 확인하세요")
                }
              >
                테스트 알림 보내기
              </button>
              <button type="button" className="btn" disabled={pushBusy} onClick={() => void runPush(disablePush, "알림을 껐어요")}>
                끄기
              </button>
            </div>
          </>
        )}
        <dl className="kv">
          <dt>브라우저 알림 권한</dt>
          <dd>{notificationPermission()}</dd>
          <dt>마지막으로 푸시를 받은 시각</dt>
          <dd>{pushedAt ? formatDate(pushedAt) : "아직 받은 적 없음"}</dd>
          {pushError && (
            <>
              <dt>알림 표시 오류</dt>
              <dd>{pushError}</dd>
            </>
          )}
          {pushSyncError && (
            <>
              <dt>알림으로 깨어난 동기화 실패 원인</dt>
              <dd>{pushSyncError}</dd>
            </>
          )}
        </dl>
        <div className="row">
          <button type="button" className="btn small" onClick={() => void loadPush()}>
            상태 새로고침
          </button>
        </div>
      </section>

      <section className="panel">
        <h2>폰에 설치하기</h2>
        <ol className="steps">
          <li>PC에서 Tailscale을 켜고 이 앱을 tailnet에 공개해요: <code>tailscale serve --bg 4313</code></li>
          <li>폰에도 Tailscale을 설치·로그인한 뒤, 표시된 <code>https://…ts.net</code> 주소를 크롬(안드로이드) 또는 사파리(iOS)로 열어요.</li>
          <li>메뉴에서 “홈 화면에 추가”(앱 설치)를 선택하면 공유 메뉴에도 MemoReader가 나타나요.</li>
        </ol>
      </section>
    </div>
  );
}
