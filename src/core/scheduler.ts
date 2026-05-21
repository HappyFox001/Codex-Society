import type { AgentId } from "./types.js";

export interface SchedulePlan {
  agentsForTick(tick: number, agentIds: AgentId[]): AgentId[];
}

export class RoundRobinSchedule implements SchedulePlan {
  agentsForTick(_tick: number, agentIds: AgentId[]): AgentId[] {
    return [...agentIds];
  }
}

export class OneAgentPerTickSchedule implements SchedulePlan {
  agentsForTick(tick: number, agentIds: AgentId[]): AgentId[] {
    if (agentIds.length === 0) {
      return [];
    }
    return [agentIds[tick % agentIds.length]];
  }
}
