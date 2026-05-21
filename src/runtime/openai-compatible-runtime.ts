import { z } from "zod";
import type { AgentDecision, Observation } from "../core/types.js";
import { actionSchema } from "../core/types.js";
import type { AgentRuntime } from "./agent-runtime.js";

export interface OpenAiCompatibleRuntimeOptions {
  baseUrl: string;
  apiKey?: string;
  model: string;
  timeoutMs?: number;
}

const decisionSchema = z.object({
  thought: z.string(),
  actions: z.array(actionSchema),
});

export class OpenAiCompatibleRuntime implements AgentRuntime {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(options: OpenAiCompatibleRuntimeOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  async decide(observation: Observation): Promise<AgentDecision> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            {
              role: "system",
              content:
                "You are an agent in a social simulator. Return only JSON with shape {\"thought\": string, \"actions\": AgentAction[]}.",
            },
            {
              role: "user",
              content: JSON.stringify(observation),
            },
          ],
          response_format: { type: "json_object" },
        }),
      });

      if (!response.ok) {
        throw new Error(`OpenAI-compatible runtime failed: HTTP ${response.status} ${await response.text()}`);
      }

      const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = payload.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error("OpenAI-compatible runtime returned an empty message");
      }

      return decisionSchema.parse(JSON.parse(content));
    } finally {
      clearTimeout(timer);
    }
  }
}
