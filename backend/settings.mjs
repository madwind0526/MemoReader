import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { DEFAULT_ORGANIZE } from "../shared/item.mjs";

// CLI providers use a command the user is already signed in to, so they need no endpoint or key.
export const LLM_PROVIDERS = ["none", "claude-cli", "codex-cli", "opencode-cli", "ollama", "anthropic", "openai", "gemini"];

const DEFAULTS = Object.freeze({
  version: 1,
  // `fallback`: when the chosen provider fails, try the others in order. `ollamaModel`: the local model
  // used when Ollama is only a fallback (empty = pick an installed one automatically).
  llm: { provider: "none", endpoint: "", model: "", apiKey: "", fallback: true, ollamaModel: "" },
  organize: { ...DEFAULT_ORGANIZE },
  telegram: { enabled: false, botToken: "", allowedChatIds: [] },
  auth: { allowedLogins: [] },
});

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback;
}

function text(value, limit = 500) {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

function list(value, pattern, limit = 20) {
  const source = Array.isArray(value) ? value : String(value ?? "").split(/[\s,]+/);
  const out = [];
  for (const entry of source) {
    const item = String(entry).trim();
    if (item && pattern.test(item) && !out.includes(item)) out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

function normalize(raw, env) {
  const llm = raw?.llm ?? {};
  const organize = raw?.organize ?? {};
  const telegram = raw?.telegram ?? {};
  const auth = raw?.auth ?? {};
  return {
    version: 1,
    llm: {
      provider: LLM_PROVIDERS.includes(llm.provider) ? llm.provider : DEFAULTS.llm.provider,
      endpoint: text(llm.endpoint, 500),
      model: text(llm.model, 100),
      apiKey: text(llm.apiKey, 500) || text(env.LLM_API_KEY, 500),
      fallback: llm.fallback !== false,
      ollamaModel: text(llm.ollamaModel, 100),
    },
    organize: {
      summaryLines: clampInt(organize.summaryLines, 1, 10, DEFAULT_ORGANIZE.summaryLines),
      maxTags: clampInt(organize.maxTags, 1, 15, DEFAULT_ORGANIZE.maxTags),
      render: organize.render !== false,
      useLogin: organize.useLogin === true,
    },
    telegram: {
      enabled: telegram.enabled === true,
      botToken: text(telegram.botToken, 200),
      allowedChatIds: list(telegram.allowedChatIds, /^-?\d{1,20}$/),
    },
    auth: {
      allowedLogins: list(auth.allowedLogins, /^[^\s,]{3,100}$/).map((login) => login.toLowerCase()),
    },
  };
}

export async function createSettings(dataDir, env = process.env) {
  const file = path.join(dataDir, "runtime", "settings.json");
  let current;
  try {
    current = normalize(JSON.parse(await readFile(file, "utf8")), env);
  } catch {
    current = normalize({}, env);
  }
  // `apiKey` may come from the environment; only what the user typed is written back to disk.
  let stored = current;
  const listeners = new Set();

  async function persist(next) {
    await mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(next, null, 2), "utf8");
    await rename(temp, file);
  }

  return {
    get: () => current,

    /** The view sent to the browser: secrets are reported as booleans, never echoed back. */
    toClient() {
      return {
        llm: {
          provider: current.llm.provider,
          endpoint: current.llm.endpoint,
          model: current.llm.model,
          hasApiKey: Boolean(current.llm.apiKey),
          fallback: current.llm.fallback,
          ollamaModel: current.llm.ollamaModel,
        },
        organize: { ...current.organize },
        telegram: {
          enabled: current.telegram.enabled,
          hasBotToken: Boolean(current.telegram.botToken),
          allowedChatIds: [...current.telegram.allowedChatIds],
        },
        auth: { allowedLogins: [...current.auth.allowedLogins] },
      };
    },

    /** Merges a partial update from the settings screen. Empty secret fields keep the stored value. */
    async update(patch = {}) {
      const next = structuredClone(stored);
      if (patch.llm) {
        const llm = patch.llm;
        if ("provider" in llm) next.llm.provider = llm.provider;
        if ("endpoint" in llm) next.llm.endpoint = llm.endpoint;
        if ("model" in llm) next.llm.model = llm.model;
        if ("fallback" in llm) next.llm.fallback = llm.fallback !== false;
        if ("ollamaModel" in llm) next.llm.ollamaModel = llm.ollamaModel;
        if (typeof llm.apiKey === "string" && llm.apiKey.trim()) next.llm.apiKey = llm.apiKey;
        if (llm.clearApiKey === true) next.llm.apiKey = "";
      }
      if (patch.organize) {
        Object.assign(next.organize, patch.organize);
        next.organize.useLogin = next.organize.useLogin === true;
        next.organize.render = next.organize.render !== false;
      }
      if (patch.telegram) {
        const telegram = patch.telegram;
        if ("enabled" in telegram) next.telegram.enabled = telegram.enabled;
        if ("allowedChatIds" in telegram) next.telegram.allowedChatIds = telegram.allowedChatIds;
        if (typeof telegram.botToken === "string" && telegram.botToken.trim()) next.telegram.botToken = telegram.botToken;
        if (telegram.clearBotToken === true) next.telegram.botToken = "";
      }
      if (patch.auth && "allowedLogins" in patch.auth) next.auth.allowedLogins = patch.auth.allowedLogins;

      // `stored` keeps the typed key only; `current` also folds in the environment fallback.
      stored = normalize(next, {});
      await persist(stored);
      current = normalize(stored, env);
      for (const listener of listeners) listener(current);
      return current;
    },

    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
