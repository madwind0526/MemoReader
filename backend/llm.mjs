import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "cross-spawn";

export class LlmError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "LlmError";
    this.status = status;
  }
}

const DEFAULT_ENDPOINTS = {
  anthropic: "https://api.anthropic.com/v1/messages",
  openai: "https://api.openai.com/v1/responses",
  gemini: "https://generativelanguage.googleapis.com/v1beta",
  ollama: "http://127.0.0.1:11434",
};

const CLI_TIMEOUT_MS = 120_000;
const API_TIMEOUT_MS = 120_000;
// Order matters: the bare name covers Unix shims, the rest are the Windows wrappers npm installs.
const WINDOWS_EXECUTABLE_EXTENSIONS = ["", ".cmd", ".exe", ".ps1", ".bat"];
const ANSI_PATTERN = /\u001B\[[0-9;?]*[A-Za-z]/g;

/** Scans PATH without spawning, so the settings screen can poll it cheaply. */
export function isCommandInstalled(command, env = process.env) {
  const directories = (env.PATH || env.Path || "").split(path.delimiter).filter(Boolean);
  for (const directory of directories) {
    for (const extension of WINDOWS_EXECUTABLE_EXTENSIONS) {
      try {
        if (existsSync(path.join(directory, `${command}${extension}`))) return true;
      } catch {
        // Unreadable PATH entries are skipped.
      }
    }
  }
  return false;
}

// cross-spawn resolves the real .cmd/.ps1 wrapper on Windows and still passes arguments through argv,
// so text containing &, |, ` or $() cannot become a second command. The prompt goes through stdin
// because a large argument routed through the Windows .cmd wrapper gets mangled.
export function runCommand(command, args, { stdin, timeoutMs = CLI_TIMEOUT_MS, onStdout } = {}) {
  return new Promise((resolve, reject) => {
    // A neutral working directory keeps a project's CLAUDE.md/AGENTS.md from leaking into the answer.
    const child = spawn(command, args, { windowsHide: true, cwd: os.tmpdir() });
    let stdout = "";
    let stderr = "";
    let settled = false;
    // spawn's own `timeout` only ends the program it started. A CLI wrapper (opencode, codex) keeps a child
    // that holds the output pipe open, so "close" never fires and the whole queue stalls. Own the timer:
    // end the whole process tree and fail the call at once instead of waiting for "close".
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killTree(child);
      reject(new LlmError(`${command} 응답이 ${Math.round(timeoutMs / 1000)}초 안에 오지 않아 중단했습니다.`, 504));
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
      onStdout?.(chunk);
    });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code !== 0) {
        // Several CLIs print the reason (usage limit, login expired, ...) on stdout and leave stderr empty.
        const reason = (stderr.trim() || cleanCliOutput(stdout)).slice(0, 300);
        reject(new LlmError(`${command} 실행에 실패했습니다 (종료 코드 ${code}): ${reason || "CLI가 이유를 알려 주지 않았습니다"}`, 502));
        return;
      }
      resolve(stdout);
    });
    child.stdin?.end(stdin);
  });
}

/** Ends a process and everything it started (taskkill /T on Windows; elsewhere only the process itself). */
function killTree(child) {
  try {
    if (process.platform === "win32" && child.pid) spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => {});
    else child.kill("SIGKILL");
  } catch {
    // the process may already be gone
  }
}

function cleanCliOutput(textValue) {
  return String(textValue ?? "")
    .replace(ANSI_PATTERN, "")
    .split(/\r?\n/)
    // opencode prints a "> agent · model" header line before the answer.
    .filter((line) => !/^\s*>\s/.test(line))
    .join("\n")
    .trim();
}

// Organizing needs none of what a full Claude Code session loads (MCP servers, plugins, hooks, skills,
// tools, its own long system prompt). Leaving those out halved the time per memo in measurements
// (18.7 s -> 9.1 s for the same prompt, same quality), keeps the CLI's login, and also means
// untrusted page text can never reach a tool.
const CLAUDE_TRIMMED_FLAGS = ["--strict-mcp-config", "--tools", "", "--disable-slash-commands", "--setting-sources", "project"];
// A stuck call is more likely to recover on a fresh attempt than by waiting; typical calls take ~10 s.
const CLAUDE_ATTEMPT_TIMEOUT_MS = 90_000;
const UNKNOWN_FLAG = /unknown (option|argument)|unrecognized (option|argument)|invalid option/i;

// Set once when the installed CLI does not know the flags above, so later calls skip straight to plain mode.
let claudeTrimmedUnsupported = false;

/** Forgets that the CLI lacked the trimmed flags (used by tests). */
export function resetCliCompatibility() {
  claudeTrimmedUnsupported = false;
}

// Failures a second try cannot fix: the allowance is used up or the login is gone. Waiting only delays
// the fallback to the next provider.
const NOT_WORTH_RETRYING = /limit|quota|credit balance|usage|not logged in|log in|login|authenticat|unauthorized|invalid api key/i;

async function retryOnce(task) {
  try {
    return await task();
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    // A CLI that does not know a flag will not learn it on a second try either.
    if (UNKNOWN_FLAG.test(message) || NOT_WORTH_RETRYING.test(message)) throw error;
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return task();
  }
}

async function askClaude({ system, user, model }) {
  const modelArgs = model ? ["--model", model] : [];

  if (!claudeTrimmedUnsupported) {
    // The instructions go in a file: a long argument is mangled by the Windows .cmd wrapper.
    const systemFile = path.join(os.tmpdir(), `memoreader-system-${randomUUID()}.txt`);
    await writeFile(systemFile, system, "utf8");
    try {
      return await retryOnce(() =>
        runCommand("claude", ["-p", ...CLAUDE_TRIMMED_FLAGS, "--system-prompt-file", systemFile, ...modelArgs], {
          stdin: user,
          timeoutMs: CLAUDE_ATTEMPT_TIMEOUT_MS,
        }),
      );
    } catch (error) {
      if (!UNKNOWN_FLAG.test(error instanceof Error ? error.message : "")) throw error;
      claudeTrimmedUnsupported = true;
    } finally {
      await rm(systemFile, { force: true });
    }
  }

  // An older CLI without those flags: the original way, everything in one prompt.
  return runCommand("claude", ["-p", ...modelArgs], { stdin: `${system}\n\n${user}` });
}

const CLI_PROVIDERS = {
  "claude-cli": { command: "claude", run: askClaude },
  "codex-cli": {
    command: "codex",
    args: (model) => ["exec", "--ephemeral", "--sandbox", "read-only", "--skip-git-repo-check", "--color", "never", ...(model ? ["--model", model] : []), "-"],
  },
  "opencode-cli": { command: "opencode", args: (model) => ["run", "--pure", ...(model ? ["--model", model] : [])] },
};

export function isCliProvider(provider) {
  return Object.hasOwn(CLI_PROVIDERS, provider);
}

async function failure(response, provider) {
  const body = await response.text().catch(() => "");
  throw new LlmError(`${provider} 호출에 실패했습니다 (${response.status}): ${body.slice(0, 200)}`, 502);
}

/**
 * Builds a `complete(system, user) -> string` function for the configured provider.
 * Throws LlmError with a Korean, user-fixable message when the setup is incomplete.
 */
export function createLlmClient(config, fetchImpl = globalThis.fetch) {
  const { provider = "none", model = "", apiKey = "" } = config ?? {};

  if (provider === "none") throw new LlmError("설정에서 LLM 제공업체를 선택해 주세요.");

  if (isCliProvider(provider)) {
    const cli = CLI_PROVIDERS[provider];
    if (!isCommandInstalled(cli.command)) {
      throw new LlmError(`${cli.command} 명령을 찾을 수 없습니다. CLI를 설치하고 로그인한 뒤 다시 시도해 주세요.`);
    }
    return {
      provider,
      async complete(system, user) {
        const output = cli.run
          ? await cli.run({ system, user, model })
          : await runCommand(cli.command, cli.args(model), { stdin: `${system}\n\n${user}` });
        return cleanCliOutput(output);
      },
    };
  }

  const endpoint = config?.endpoint || DEFAULT_ENDPOINTS[provider];
  if (!endpoint || !model) throw new LlmError("LLM 연결 주소와 모델을 설정해 주세요.");
  if (provider !== "ollama" && !apiKey) throw new LlmError("선택한 LLM의 API 키를 설정해 주세요.");

  return {
    provider,
    async complete(system, user) {
      let url = endpoint;
      let headers = { "Content-Type": "application/json" };
      let body;
      if (provider === "anthropic") {
        headers = { ...headers, "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
        body = { model, max_tokens: 2048, system, messages: [{ role: "user", content: user }] };
      } else if (provider === "openai") {
        headers = { ...headers, Authorization: `Bearer ${apiKey}` };
        body = { model, store: false, instructions: system, input: user };
      } else if (provider === "gemini") {
        url = `${endpoint.replace(/\/$/, "")}/models/${encodeURIComponent(model)}:generateContent`;
        headers = { ...headers, "x-goog-api-key": apiKey };
        body = {
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: [{ text: user }] }],
          generationConfig: { responseMimeType: "application/json" },
        };
      } else if (provider === "ollama") {
        url = new URL("/api/chat", endpoint).toString();
        body = {
          model,
          stream: false,
          format: "json",
          messages: [{ role: "system", content: system }, { role: "user", content: user }],
          options: { num_ctx: 8192 },
          keep_alive: "30m",
        };
      } else {
        throw new LlmError("지원하지 않는 LLM 제공업체입니다.");
      }

      const response = await fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });
      if (!response.ok) await failure(response, provider);
      const payload = await response.json();
      if (provider === "anthropic") return (payload.content ?? []).map((part) => part.text ?? "").join("");
      if (provider === "openai") {
        if (typeof payload.output_text === "string") return payload.output_text;
        return (payload.output ?? []).flatMap((entry) => entry.content ?? []).map((part) => part.text ?? "").join("");
      }
      if (provider === "gemini") return (payload.candidates?.[0]?.content?.parts ?? []).map((part) => part.text ?? "").join("");
      return payload.message?.content ?? "";
    },
  };
}

// ---- automatic fallback ------------------------------------------------------------------------

/** The order tried when the chosen provider fails: Claude, then Codex, then OpenCode, then local Ollama. */
export const FALLBACK_ORDER = ["claude-cli", "codex-cli", "opencode-cli", "ollama"];

export const PROVIDER_LABELS = {
  "claude-cli": "Claude CLI",
  "codex-cli": "Codex CLI",
  "opencode-cli": "OpenCode CLI",
  ollama: "Ollama",
  anthropic: "Claude API",
  openai: "OpenAI API",
  gemini: "Gemini API",
};

// A provider that just failed (usage limit used up, login expired, service down) is skipped for a while
// so the following memos do not each waste time on it, then tried again.
const COOLDOWN_MS = 10 * 60_000;
const cooldownUntil = new Map();

/** Forgets which providers are resting (used by tests). */
export function resetFallbackState() {
  cooldownUntil.clear();
}

const label = (provider) => PROVIDER_LABELS[provider] ?? provider;
const messageOf = (error) => (error instanceof Error ? error.message : String(error));

/** The providers to try, in order: the chosen one first, then the rest of the fallback order. */
export function chainFor(config) {
  const primary = config?.provider ?? "none";
  const rest = config?.fallback === false ? [] : FALLBACK_ORDER.filter((provider) => provider !== primary);
  // When another provider is the main one, Claude is only the last resort so memo organizing does not
  // use up the Claude quota the user needs for coding.
  if (primary !== "claude-cli" && rest.includes("claude-cli")) return [primary, ...rest.filter((provider) => provider !== "claude-cli"), "claude-cli"];
  return [primary, ...rest];
}

/**
 * Which installed Ollama model to use when none is configured: the smallest real model of at least
 * 4 GB (small enough to answer quickly, big enough for Korean), else the biggest there is.
 */
async function detectOllamaModel(endpoint, fetchImpl) {
  try {
    const response = await fetchImpl(new URL("/api/tags", endpoint || DEFAULT_ENDPOINTS.ollama), { signal: AbortSignal.timeout(2500) });
    const { models = [] } = await response.json();
    const real = models.filter((model) => !/embed|rerank|bge|minilm/i.test(model.name));
    const mid = real.filter((model) => model.size >= 4e9).sort((a, b) => a.size - b.size);
    return (mid[0] ?? real.sort((a, b) => b.size - a.size)[0])?.name ?? "";
  } catch {
    return "";
  }
}

/** The settings for one provider in the chain. Only the chosen provider uses the user's model/endpoint/key. */
async function configFor(provider, config, fetchImpl) {
  if (provider === config.provider) return config;
  if (provider === "ollama") {
    const model = config.ollamaModel || (await detectOllamaModel("", fetchImpl));
    if (!model) throw new LlmError("Ollama가 꺼져 있거나 설치된 모델이 없습니다.");
    return { provider, model };
  }
  return { provider, model: "" };
}

/**
 * Like createLlmClient, but when the chosen provider fails (no tokens left, login expired, not
 * installed, bad answer) the next one in FALLBACK_ORDER is tried automatically. `accept(text)` may
 * throw to reject an unusable answer, which also moves on to the next provider.
 */
export function createFallbackClient(config, { createSingle = createLlmClient, now = Date.now, fetchImpl = globalThis.fetch } = {}) {
  const primary = config?.provider ?? "none";
  if (primary === "none") throw new LlmError("설정에서 LLM 제공업체를 선택해 주세요.");
  const chain = chainFor(config);
  const report = { lastUsed: "", skipped: [] };

  async function attempt(provider, system, user, accept, ignoreCooldown) {
    if (!ignoreCooldown && (cooldownUntil.get(provider) ?? 0) > now()) {
      return { skipped: `${label(provider)}: 이전에 실패해서 잠시 쉬는 중이에요` };
    }
    let client;
    try {
      client = createSingle(await configFor(provider, config, fetchImpl));
    } catch (error) {
      return { failed: `${label(provider)}: ${messageOf(error)}`, original: error };
    }
    let text;
    try {
      text = await client.complete(system, user);
    } catch (error) {
      cooldownUntil.set(provider, now() + COOLDOWN_MS);
      return { failed: `${label(provider)}: ${messageOf(error)}`, original: error };
    }
    try {
      accept?.(text);
    } catch (error) {
      // A bad answer says nothing about the provider's health, so it does not start a rest period.
      return { failed: `${label(provider)}: ${messageOf(error)}`, original: error };
    }
    cooldownUntil.delete(provider);
    return { text };
  }

  return {
    provider: primary,
    get lastUsed() {
      return report.lastUsed;
    },
    get skipped() {
      return report.skipped;
    },
    async complete(system, user, { accept } = {}) {
      const failures = [];
      let firstError = null;
      report.skipped = [];
      for (const ignoreCooldown of [false, true]) {
        let triedAny = false;
        for (const provider of chain) {
          if (failures.some((entry) => entry.provider === provider)) continue;
          const result = await attempt(provider, system, user, accept, ignoreCooldown);
          if ("text" in result) {
            report.lastUsed = provider;
            return result.text;
          }
          if (result.skipped) {
            report.skipped.push(result.skipped);
            continue;
          }
          triedAny = true;
          firstError ??= result.original;
          failures.push({ provider, message: result.failed });
          // What was passed over on the way to the answer, shown by the settings screen's connection test.
          report.skipped.push(result.failed);
        }
        // If every provider was resting there is nothing to wait for: try them anyway.
        if (triedAny) break;
      }
      // Without a fallback the provider's own message is the most useful one.
      if (chain.length === 1 && firstError) throw firstError;
      throw new LlmError(`정리 방식을 모두 시도했지만 실패했어요. ${failures.map((entry) => entry.message).join(" / ")}`, 502);
    },
  };
}

/** What the settings screen shows for each provider in the chain (no network, no model call). */
export function describeChain(config) {
  return chainFor(config).map((provider) => {
    const name = label(provider);
    if (provider === "none") return { provider, label: "없음", state: "missing", note: "LLM이 선택되지 않았습니다." };
    if (provider === "ollama") {
      const ready = provider !== config.provider || Boolean(config.model);
      return { provider, label: name, state: "check", note: ready ? "실행 중인지는 호출할 때 확인해요" : "모델을 설정해 주세요" };
    }
    try {
      createLlmClient(provider === config.provider ? config : { provider }, () => {
        throw new Error("not called");
      });
      return { provider, label: name, state: "ready", note: "사용할 수 있어요" };
    } catch (error) {
      return { provider, label: name, state: "missing", note: messageOf(error) };
    }
  });
}

/** Cheap readiness check for the settings screen (no network, no model call). */
export function describeLlm(config) {
  const provider = config?.provider ?? "none";
  if (provider === "none") return { ready: false, message: "LLM이 선택되지 않았습니다.", chain: [] };
  const chain = describeChain(config);
  const usable = chain.filter((entry) => entry.state !== "missing");
  if (!usable.length) return { ready: false, message: chain[0]?.note ?? "사용할 수 있는 방식이 없습니다.", chain };
  const first = chain[0];
  const message =
    first.state === "missing"
      ? `${first.label}는 쓸 수 없지만 ${usable[0].label}(으)로 자동 전환돼요.`
      : chain.length > 1
        ? `${first.label}를 먼저 쓰고, 실패하면 ${chain.slice(1).map((entry) => entry.label).join(" → ")} 순서로 자동 전환돼요.`
        : "사용할 수 있습니다.";
  return { ready: true, message, chain };
}
