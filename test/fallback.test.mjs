// The automatic fallback chain: Claude -> Codex -> OpenCode -> Ollama, with fake providers.
import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";

import { FALLBACK_ORDER, LlmError, chainFor, createFallbackClient, describeLlm, resetFallbackState } from "../backend/llm.mjs";

beforeEach(() => resetFallbackState());

/** A fake createLlmClient: `behaviour[provider]` is a function (text) or an Error to throw. */
function fakes(behaviour) {
  const log = [];
  const createSingle = (config) => {
    log.push({ built: config.provider, config });
    const action = behaviour[config.provider];
    if (action instanceof Error && action.setup) throw action;
    return {
      provider: config.provider,
      async complete() {
        log.push({ called: config.provider });
        if (action instanceof Error) throw action;
        return typeof action === "function" ? action() : action;
      },
    };
  };
  return { createSingle, log, called: () => log.filter((entry) => entry.called).map((entry) => entry.called) };
}

const setupError = (message) => Object.assign(new LlmError(message), { setup: true });
const limit = () => new LlmError("claude 실행에 실패했습니다 (종료 코드 1): You've hit your usage limit");

test("the chain starts with the chosen provider, then follows the fixed order", () => {
  assert.deepEqual(chainFor({ provider: "claude-cli" }), ["claude-cli", "codex-cli", "opencode-cli", "ollama"]);
  // Claude is kept for coding: it is only the last resort unless it is the chosen provider.
  assert.deepEqual(chainFor({ provider: "codex-cli" }), ["codex-cli", "opencode-cli", "ollama", "claude-cli"]);
  assert.deepEqual(chainFor({ provider: "anthropic" }), ["anthropic", "codex-cli", "opencode-cli", "ollama", "claude-cli"]);
  assert.deepEqual(chainFor({ provider: "claude-cli", fallback: false }), ["claude-cli"]);
});

test("when the chosen provider works, nobody else is asked", async () => {
  const { createSingle, called } = fakes({ "claude-cli": "A", "codex-cli": "B" });
  const client = createFallbackClient({ provider: "claude-cli" }, { createSingle });
  assert.equal(await client.complete("s", "u"), "A");
  assert.deepEqual(called(), ["claude-cli"]);
  assert.equal(client.lastUsed, "claude-cli");
});

test("Claude out of tokens: Codex answers, and Claude rests so later memos skip it", async () => {
  let clock = 1_000_000;
  const { createSingle, called } = fakes({ "claude-cli": limit(), "codex-cli": "FROM CODEX" });
  const client = createFallbackClient({ provider: "claude-cli" }, { createSingle, now: () => clock });

  assert.equal(await client.complete("s", "u"), "FROM CODEX");
  assert.deepEqual(called(), ["claude-cli", "codex-cli"]);
  assert.equal(client.lastUsed, "codex-cli");
  assert.match(client.skipped[0], /Claude CLI: .*usage limit/);

  assert.equal(await client.complete("s", "u"), "FROM CODEX");
  assert.deepEqual(called(), ["claude-cli", "codex-cli", "codex-cli"], "the second memo does not touch Claude again");
  assert.match(client.skipped[0], /잠시 쉬는 중/);

  clock += 11 * 60_000;
  assert.equal(await client.complete("s", "u"), "FROM CODEX");
  assert.deepEqual(called().slice(3), ["claude-cli", "codex-cli"], "after the rest Claude is tried again");
});

test("a recovered provider is used again at once", async () => {
  let clock = 0;
  const behaviour = { "claude-cli": limit(), "codex-cli": "CODEX" };
  const { createSingle } = fakes(behaviour);
  const client = createFallbackClient({ provider: "claude-cli" }, { createSingle, now: () => clock });
  assert.equal(await client.complete("s", "u"), "CODEX");
  behaviour["claude-cli"] = "CLAUDE BACK";
  clock += 11 * 60_000;
  assert.equal(await client.complete("s", "u"), "CLAUDE BACK");
  assert.equal(await client.complete("s", "u"), "CLAUDE BACK", "no longer resting once it worked");
});

test("a bad answer moves on to the next provider without making the first one rest", async () => {
  const { createSingle, called } = fakes({ "claude-cli": "not json", "codex-cli": '{"ok":true}' });
  const client = createFallbackClient({ provider: "claude-cli" }, { createSingle });
  const accept = (text) => {
    JSON.parse(text);
  };
  assert.equal(await client.complete("s", "u", { accept }), '{"ok":true}');
  assert.deepEqual(called(), ["claude-cli", "codex-cli"]);
  await client.complete("s", "u", { accept });
  assert.deepEqual(called().slice(2), ["claude-cli", "codex-cli"], "Claude is still tried first next time");
});

test("a provider that is not installed is skipped", async () => {
  const { createSingle, called } = fakes({ "claude-cli": setupError("claude 명령을 찾을 수 없습니다."), "codex-cli": "CODEX" });
  const client = createFallbackClient({ provider: "claude-cli" }, { createSingle });
  assert.equal(await client.complete("s", "u"), "CODEX");
  assert.deepEqual(called(), ["codex-cli"]);
});

test("each fallback uses its own defaults, never the chosen provider's model", async () => {
  const { createSingle, log } = fakes({ "claude-cli": limit(), "codex-cli": limit(), "opencode-cli": "OPENCODE" });
  const client = createFallbackClient({ provider: "claude-cli", model: "haiku", apiKey: "secret", fallback: true }, { createSingle });
  assert.equal(await client.complete("s", "u"), "OPENCODE");
  const configs = Object.fromEntries(log.filter((entry) => entry.built).map((entry) => [entry.built, entry.config]));
  assert.equal(configs["claude-cli"].model, "haiku");
  assert.deepEqual(configs["codex-cli"], { provider: "codex-cli", model: "" });
  assert.deepEqual(configs["opencode-cli"], { provider: "opencode-cli", model: "" });
});

test("Ollama as the last resort picks a sensible installed model, or uses the configured one", async () => {
  const tags = { models: [{ name: "big:26b", size: 17e9 }, { name: "nomic-embed-text", size: 0.3e9 }, { name: "mid:9b", size: 6e9 }, { name: "tiny:1b", size: 1e9 }, { name: "other:8b", size: 9e9 }] };
  const fetchImpl = async () => ({ json: async () => tags });
  const failing = { "claude-cli": limit(), "codex-cli": limit(), "opencode-cli": limit(), ollama: "LOCAL" };

  const auto = fakes(failing);
  assert.equal(await createFallbackClient({ provider: "claude-cli" }, { createSingle: auto.createSingle, fetchImpl }).complete("s", "u"), "LOCAL");
  assert.equal(auto.log.find((entry) => entry.built === "ollama").config.model, "mid:9b", "the smallest real model of at least 4 GB");

  resetFallbackState();
  const chosen = fakes(failing);
  await createFallbackClient({ provider: "claude-cli", ollamaModel: "other:8b" }, { createSingle: chosen.createSingle, fetchImpl }).complete("s", "u");
  assert.equal(chosen.log.find((entry) => entry.built === "ollama").config.model, "other:8b");

  resetFallbackState();
  const nothing = fakes(failing);
  await assert.rejects(
    createFallbackClient({ provider: "claude-cli" }, { createSingle: nothing.createSingle, fetchImpl: async () => { throw new Error("connection refused"); } }).complete("s", "u"),
    /Ollama가 꺼져 있거나/,
  );
});

test("when everything fails the message lists every provider's reason", async () => {
  const { createSingle } = fakes({
    "claude-cli": limit(),
    "codex-cli": new LlmError("codex 실행에 실패했습니다 (종료 코드 1): not logged in"),
    "opencode-cli": setupError("opencode 명령을 찾을 수 없습니다."),
    ollama: new LlmError("ollama 호출에 실패했습니다 (404): model not found"),
  });
  const client = createFallbackClient({ provider: "claude-cli", ollamaModel: "x" }, { createSingle });
  await assert.rejects(client.complete("s", "u"), (error) => {
    assert.match(error.message, /정리 방식을 모두 시도했지만 실패했어요/);
    for (const part of ["Claude CLI: ", "usage limit", "Codex CLI: ", "not logged in", "OpenCode CLI: ", "찾을 수 없", "Ollama: ", "model not found"]) {
      assert.ok(error.message.includes(part), `missing "${part}"`);
    }
    return true;
  });
});

test("when every provider is resting they are tried anyway instead of failing without a try", async () => {
  let clock = 0;
  const behaviour = { "claude-cli": limit(), "codex-cli": limit(), "opencode-cli": limit(), ollama: limit() };
  const { createSingle, called } = fakes(behaviour);
  const client = createFallbackClient({ provider: "claude-cli", ollamaModel: "x" }, { createSingle, now: () => clock });
  await assert.rejects(client.complete("s", "u"));
  behaviour["codex-cli"] = "CODEX AGAIN";
  const before = called().length;
  assert.equal(await client.complete("s", "u"), "CODEX AGAIN", "all were resting, so the cooldown is ignored");
  assert.ok(called().length > before);
});

test("without a fallback the provider's own error comes through unchanged", async () => {
  const error = limit();
  const { createSingle, called } = fakes({ "claude-cli": error, "codex-cli": "WOULD WORK" });
  const client = createFallbackClient({ provider: "claude-cli", fallback: false }, { createSingle });
  await assert.rejects(client.complete("s", "u"), (thrown) => thrown === error);
  assert.deepEqual(called(), ["claude-cli"]);
});

test("choosing no provider is a setup error, as before", () => {
  assert.throws(() => createFallbackClient({ provider: "none" }), /LLM 제공업체를 선택해 주세요/);
});

test("the settings screen can tell which providers are usable", () => {
  const status = describeLlm({ provider: "claude-cli", fallback: true });
  assert.equal(status.chain.length, 4);
  assert.deepEqual(status.chain.map((entry) => entry.provider), ["claude-cli", "codex-cli", "opencode-cli", "ollama"]);
  assert.equal(status.chain.at(-1).state, "check", "Ollama is only checked when it is called");
  assert.equal(describeLlm({ provider: "none" }).ready, false);
  assert.deepEqual(describeLlm({ provider: "claude-cli", fallback: false }).chain.map((entry) => entry.provider), ["claude-cli"]);
});
