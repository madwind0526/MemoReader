// A CLI that hangs must not stall the organizer: after the time limit the whole process tree is ended and the call fails.
import assert from "node:assert/strict";
import test from "node:test";

import { runCommand } from "../backend/llm.mjs";

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("a hung CLI whose child keeps the output pipe open is stopped at the time limit, child included", async () => {
  // The parent starts a grandchild that inherits stdout and sleeps, then sleeps itself: "close" would never fire.
  const script = `
    const { spawn } = require("node:child_process");
    const grandchild = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 60000)"], { stdio: ["ignore", "inherit", "inherit"] });
    console.log("GRANDCHILD:" + grandchild.pid);
    setTimeout(() => {}, 60000);
  `;
  const started = Date.now();
  let output = "";
  await assert.rejects(
    runCommand(process.execPath, ["-e", script], { stdin: "", timeoutMs: 1500, onStdout: (chunk) => { output += chunk; } }),
    /안에 오지 않아 중단했습니다/,
  );
  assert.ok(Date.now() - started < 6000, "the call failed promptly instead of waiting for the processes");
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const pid = Number(/GRANDCHILD:(\d+)/.exec(output)?.[1]);
  if (process.platform === "win32") assert.ok(pid > 0 && !alive(pid), "the child process was ended too");
});

test("a CLI that finishes in time still returns its output", async () => {
  const text = await runCommand(process.execPath, ["-e", "process.stdout.write('done')"], { stdin: "", timeoutMs: 5000 });
  assert.equal(text, "done");
});
