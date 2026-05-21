import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatBackend, ChatBackendRequest } from "./types.js";

export class EchoBackend implements ChatBackend {
  readonly id = "echo";
  readonly models = ["society-echo"];

  async complete(request: ChatBackendRequest): Promise<string> {
    return request.prompt;
  }
}

export class StaticDecisionBackend implements ChatBackend {
  readonly id = "static-decision";
  readonly models = ["society-static"];

  async complete(): Promise<string> {
    return JSON.stringify({
      thought: "Static backend returned a valid simulator decision.",
      actions: [
        {
          type: "noop",
          reason: "static backend",
        },
      ],
    });
  }
}

export interface CodexCliBackendOptions {
  command?: string;
  defaultCwd?: string;
  defaultSandbox?: "read-only" | "workspace-write" | "danger-full-access";
  timeoutMs?: number;
}

export class CodexCliBackend implements ChatBackend {
  readonly id = "codex-cli";
  readonly models = ["codex-default", "gpt-5", "gpt-5-codex"];

  private readonly command: string;
  private readonly defaultCwd: string;
  private readonly defaultSandbox: "read-only" | "workspace-write" | "danger-full-access";
  private readonly timeoutMs: number;

  constructor(options: CodexCliBackendOptions = {}) {
    this.command = options.command ?? "codex";
    this.defaultCwd = options.defaultCwd ?? process.cwd();
    this.defaultSandbox = options.defaultSandbox ?? "danger-full-access";
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  async complete(request: ChatBackendRequest): Promise<string> {
    const workDir = await mkdtemp(join(tmpdir(), "codex-society-"));
    const outputPath = join(workDir, "last-message.txt");
    const schemaPath = join(workDir, "schema.json");

    await writeFile(schemaPath, JSON.stringify(textResponseSchema(), null, 2), "utf8");

    try {
      await runCodexExec({
        command: this.command,
        prompt: request.prompt,
        outputPath,
        schemaPath,
        model: request.model,
        cwd: request.cwd ?? this.defaultCwd,
        sandbox: request.sandbox ?? this.defaultSandbox,
        timeoutMs: request.timeoutMs ?? this.timeoutMs,
      });

      return readFile(outputPath, "utf8");
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }
}

function runCodexExec(options: {
  command: string;
  prompt: string;
  outputPath: string;
  schemaPath: string;
  model: string;
  cwd: string;
  sandbox: string;
  timeoutMs: number;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      "exec",
      "--skip-git-repo-check",
      "--color",
      "never",
      "--dangerously-bypass-approvals-and-sandbox",
      "--sandbox",
      options.sandbox,
      "--ignore-user-config",
      "--ignore-rules",
      "--ephemeral",
      "--cd",
      options.cwd,
      "--output-schema",
      options.schemaPath,
      "--output-last-message",
      options.outputPath,
      "-",
    ];
    if (options.model !== "codex-default") {
      args.splice(5, 0, "--model", options.model);
    }

    const child = spawn(options.command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: options.cwd,
      env: process.env,
    });

    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Codex CLI timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs);

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Codex CLI exited with code ${code}: ${summarizeCodexStderr(stderr)}`));
    });

    child.stdin.end(options.prompt);
  });
}

function summarizeCodexStderr(stderr: string): string {
  const usefulLines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith("<") && !line.includes("<html>") && !line.includes("<svg"))
    .filter((line) => !line.includes("WARN codex_core_plugins") && !line.includes("WARN codex_core_skills"));
  return usefulLines.slice(-12).join("\n") || "no stderr output";
}

function textResponseSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      content: {
        type: "string",
      },
    },
    required: ["content"],
  };
}
