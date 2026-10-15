// The claude CLI provider, tested against a fake `claude` program so no real model is called.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

import { createLlmClient, resetCliCompatibility } from "../backend/llm.mjs";

const ANSWER = '{"title":"t","summary":"s","category":"c","tags":["a"]}';

// Records every call, then behaves as FAKE_CLAUDE_MODE says: "ok", "old" (does not know the trimmed
// flags) or "flaky" (the first call fails).
const FAKE_CLAUDE = `
import fs from "node:fs";
const args = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");
const fileFlag = args.indexOf("--system-prompt-file");
const systemFile = fileFlag >= 0 ? args[fileFlag + 1] : null;
fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({
  args,
  stdin,
  systemFile,
  systemFileContent: systemFile && fs.existsSync(systemFile) ? fs.readFileSync(systemFile, "utf8") : null,
}) + "\\n");
const mode = process.env.FAKE_CLAUDE_MODE;
if (mode === "old" && args.includes("--tools")) {
  console.error("error: unknown option '--tools'");
  process.exit(1);
}
if (mode === "limit") {
  process.stdout.write("Claude usage limit reached. Your limit will reset at 5am.\\n");
  process.exit(1);
}
if (mode === "flaky") {
  const counter = process.env.FAKE_CLAUDE_LOG + ".count";
  const seen = fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0;
  fs.writeFileSync(counter, String(seen + 1));
  if (seen === 0) {
    console.error("temporary failure");
    process.exit(1);
  }
}
process.stdout.write(${JSON.stringify(ANSWER)});
`;

let workDir;
let log;
let savedPath;

async function calls() {
  const text = await readFile(log, "utf8").catch(() => "");
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function reset(mode) {
  await rm(log, { force: true });
  await rm(`${log}.count`, { force: true });
  process.env.FAKE_CLAUDE_MODE = mode;
  resetCliCompatibility();
}

before(async () => {
  workDir = await mkdtemp(path.join(os.tmpdir(), "memoreader-fakeclaude-"));
  log = path.join(workDir, "calls.jsonl");
  await writeFile(path.join(workDir, "fake-claude.mjs"), FAKE_CLAUDE);
  if (process.platform === "win32") {
    await writeFile(path.join(workDir, "claude.cmd"), '@echo off\r\nnode "%~dp0fake-claude.mjs" %*\r\n');
  } else {
    const script = path.join(workDir, "claude");
    await writeFile(script, `#!/bin/sh\nexec node "${path.join(workDir, "fake-claude.mjs")}" "$@"\n`);
    await chmod(script, 0o755);
  }
  savedPath = process.env.PATH;
  process.env.PATH = `${workDir}${path.delimiter}${savedPath}`;
  process.env.FAKE_CLAUDE_LOG = log;
});

after(async () => {
  process.env.PATH = savedPath;
  delete process.env.FAKE_CLAUDE_LOG;
  delete process.env.FAKE_CLAUDE_MODE;
  await rm(workDir, { recursive: true, force: true });
});

test("claude is started trimmed: no MCP/tools/skills, instructions in a file, the memo on stdin", async () => {
  await reset("ok");
  const llm = createLlmClient({ provider: "claude-cli", model: "" });
  const answer = await llm.complete("SYSTEM RULES\nline two", "THE MEMO");
  assert.equal(answer, ANSWER);

  const [call] = await calls();
  assert.equal((await calls()).length, 1);
  for (const flag of ["-p", "--strict-mcp-config", "--tools", "--disable-slash-commands", "--setting-sources", "--system-prompt-file"]) {
    assert.ok(call.args.includes(flag), `missing ${flag}`);
  }
  assert.equal(call.args[call.args.indexOf("--tools") + 1], "", "all tools are switched off");
  assert.equal(call.args[call.args.indexOf("--setting-sources") + 1], "project", "the user's plugins and hooks are not loaded");
  assert.equal(call.systemFileContent, "SYSTEM RULES\nline two", "the instructions arrive intact through the file");
  assert.equal(call.stdin, "THE MEMO", "only the memo goes through stdin");
  assert.ok(!existsSync(call.systemFile), "the temporary instruction file is removed afterwards");
  assert.ok(!call.args.includes("--model"), "no model flag unless one was chosen");
});

test("a chosen model is passed along", async () => {
  await reset("ok");
  await createLlmClient({ provider: "claude-cli", model: "haiku" }).complete("S", "U");
  const [call] = await calls();
  assert.equal(call.args[call.args.indexOf("--model") + 1], "haiku");
});

test("a failed attempt is retried once", async () => {
  await reset("flaky");
  const answer = await createLlmClient({ provider: "claude-cli" }).complete("S", "U");
  assert.equal(answer, ANSWER);
  assert.equal((await calls()).length, 2, "one failure, one success");
});

test("an older claude that does not know the flags falls back to plain mode and remembers it", async () => {
  await reset("old");
  const llm = createLlmClient({ provider: "claude-cli" });

  assert.equal(await llm.complete("SYSTEM", "USER"), ANSWER);
  const first = await calls();
  assert.equal(first.length, 2, "one rejected attempt (no pointless retry), then the plain call");
  assert.ok(first.at(-1).args.length === 1 && first.at(-1).args[0] === "-p", "the last call is the plain one");
  assert.equal(first.at(-1).stdin, "SYSTEM\n\nUSER", "plain mode sends everything in one prompt");

  await rm(log, { force: true });
  assert.equal(await llm.complete("SYSTEM", "USER"), ANSWER);
  const second = await calls();
  assert.equal(second.length, 1, "later calls skip the unsupported flags");
  assert.equal(second[0].args.includes("--tools"), false);
});

test("when claude fails with its reason on stdout, that reason reaches the error message", async () => {
  await reset("limit");
  await assert.rejects(
    () => createLlmClient({ provider: "claude-cli" }).complete("S", "U"),
    (error) => {
      assert.match(error.message, /종료 코드 1/);
      assert.match(error.message, /usage limit reached/i, "the reason is not lost when stderr is empty");
      return true;
    },
  );
  assert.equal((await calls()).length, 1, "a used-up allowance is not retried, so the fallback starts at once");
});

test("no instruction files are left in the temp folder", async () => {
  await reset("ok");
  const before = (await readdir(os.tmpdir())).filter((name) => name.startsWith("memoreader-system-"));
  await createLlmClient({ provider: "claude-cli" }).complete("S", "U");
  const afterCall = (await readdir(os.tmpdir())).filter((name) => name.startsWith("memoreader-system-"));
  assert.deepEqual(afterCall.sort(), before.sort());
});
