import type { AgentDecision, Observation } from "../core/types.js";

export interface AgentRuntime {
  decide(observation: Observation): Promise<AgentDecision>;
}

export type AgentRuntimeFactory = (agentId: string) => AgentRuntime;
