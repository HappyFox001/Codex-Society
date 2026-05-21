import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { CodexCliBackend } from "../src/index.js";

const execFileAsync = promisify(execFile);
const cli = resolve("dist/cli/main.js");

test("cli smoke: init doctor run report", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "society-cli-"));
  await execFileAsync("node", [cli, "init", "--template", "campus"], { cwd });
  const doctor = await execFileAsync("node", [cli, "doctor"], { cwd });
  assert.match(doctor.stdout, /OK schemas 3 agents/);
  const run = await execFileAsync("node", [cli, "run", "--ticks", "2", "--backend", "static"], { cwd });
  assert.match(run.stdout, /Completed run_/);
  const report = await execFileAsync("node", [cli, "report"], { cwd });
  assert.match(report.stdout, /Ticks completed: 2/);
});

test("simulation target: trump china previsit", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "society-target-"));
  await execFileAsync("node", [cli, "init", "--template-dir", resolve("simulations/trump-china-previsit")], { cwd });
  const doctor = await execFileAsync("node", [cli, "doctor"], { cwd });
  assert.match(doctor.stdout, /OK schemas 6 agents/);
  const run = await execFileAsync("node", [cli, "run", "--scenario", "previsit-briefing", "--backend", "static"], { cwd });
  assert.match(run.stdout, /Completed run_/);
});

test("cli defaults to interactive shell", async () => {
  const result = new Promise<{ stdout: string }>((resolvePromise, rejectPromise) => {
    const child = execFile("node", [cli], { timeout: 2000 }, (error, stdout) => {
      if (error) {
        rejectPromise(error);
        return;
      }
      resolvePromise({ stdout });
    });
    child.stdin?.end("/exit\n");
  });
  const { stdout } = await result;
  assert.match(stdout, /Codex Society/);
  assert.match(stdout, /society>/);
});

test("codex backend defaults to full-access no-confirm mode", () => {
  const backend = new CodexCliBackend();
  assert.deepEqual(backend.models.includes("gpt-5"), true);
});
