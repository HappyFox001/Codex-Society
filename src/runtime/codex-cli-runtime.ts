import { z } from "zod";
import type { ChatBackend } from "../api/types.js";
import { CodexCliBackend } from "../api/backends.js";
import type { AgentDecision, Observation } from "../core/types.js";
import { actionSchema } from "../core/types.js";
import type { AgentRuntime } from "./agent-runtime.js";

export interface CodexCliRuntimeOptions {
  model: string;
  cwd?: string;
  timeoutMs?: number;
  sandbox?: "danger-full-access";
  backend?: ChatBackend;
}

const decisionSchema = z.object({
  thought: z.string(),
  actions: z.array(actionSchema),
});

export class CodexCliRuntime implements AgentRuntime {
  private readonly backend: ChatBackend;
  private readonly model: string;
  private readonly cwd?: string;
  private readonly timeoutMs?: number;
  private readonly sandbox: "danger-full-access";

  constructor(options: CodexCliRuntimeOptions) {
    this.backend = options.backend ?? new CodexCliBackend({ defaultSandbox: "danger-full-access", timeoutMs: options.timeoutMs });
    this.model = options.model;
    this.cwd = options.cwd;
    this.timeoutMs = options.timeoutMs;
    this.sandbox = options.sandbox ?? "danger-full-access";
  }

  async decide(observation: Observation): Promise<AgentDecision> {
    const prompt = decisionPrompt(observation);
    const first = await this.complete(prompt);
    try {
      return decisionSchema.parse(JSON.parse(first));
    } catch (error) {
      const repaired = await this.complete([
        prompt,
        "",
        "Your previous response failed validation.",
        "Validation error:",
        error instanceof Error ? error.message : String(error),
        "",
        "Previous response:",
        first,
        "",
        "Return corrected JSON only. Do not omit required fields.",
      ].join("\n"));
      return decisionSchema.parse(JSON.parse(repaired));
    }
  }

  private async complete(prompt: string): Promise<string> {
    return normalizeBackendContent(await this.backend.complete({
      model: this.model,
      cwd: this.cwd,
      timeoutMs: this.timeoutMs,
      sandbox: this.sandbox,
      prompt,
    }));
  }
}

function decisionPrompt(observation: Observation): string {
  return [
    "You are an agent inside Codex Society.",
    "Return one simulator decision for the current observation.",
    "The response content must be compact JSON only, with this exact top-level shape:",
    "{\"thought\": string, \"actions\": AgentAction[]}",
    "",
    "Allowed AgentAction variants:",
    "- say: {\"type\":\"say\",\"message\":string,\"visibility\":\"public\"|\"private\"|\"relation\"|\"agent\",\"targetId\"?:string}",
    "- remember: {\"type\":\"remember\",\"fact\":string}",
    "- updateRelation: {\"type\":\"updateRelation\",\"targetId\":string,\"trustDelta\"?:number,\"affinityDelta\"?:number}",
    "- updateEntity: {\"type\":\"updateEntity\",\"entityId\":string,\"patch\":object}",
    "- noop: {\"type\":\"noop\",\"reason\"?:string}",
    "",
    "Only use action types included in observation.self.toolPermissions.",
    "Every required field must be present. Do not invent action types. Do not include markdown or prose outside JSON.",
    "",
    "Observation JSON:",
    JSON.stringify(observation),
  ].join("\n");
}

function normalizeBackendContent(content: string): string {
  try {
    const parsed = JSON.parse(content) as { content?: unknown };
    if (typeof parsed.content === "string") return parsed.content;
  } catch {
    return content;
  }
  return content;
}
