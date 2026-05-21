import type { AgentDecision, Observation, WorldEvent } from "../core/types.js";
import type { AgentRuntime } from "./agent-runtime.js";

export class RuleBasedRuntime implements AgentRuntime {
  async decide(observation: Observation): Promise<AgentDecision> {
    const latestPublicMessage = findLatestMessage(observation.visibleEvents);
    const closestRelation = [...observation.visibleRelations].sort((a, b) => b.trust - a.trust)[0];

    if (latestPublicMessage && latestPublicMessage.actorId !== observation.self.id) {
      return {
        thought: `${observation.self.name} responds to a visible social signal.`,
        actions: [
          {
            type: "remember",
            fact: `At tick ${observation.tick}, ${latestPublicMessage.actorId} said: ${latestPublicMessage.payload.message}`,
          },
          {
            type: "say",
            targetId: latestPublicMessage.actorId,
            message: `${observation.self.name} acknowledges ${latestPublicMessage.actorId}'s message and keeps pursuing: ${observation.self.goal}`,
            visibility: "agent",
          },
          {
            type: "updateRelation",
            targetId: latestPublicMessage.actorId,
            trustDelta: 2,
            affinityDelta: 1,
          },
        ],
      };
    }

    if (closestRelation) {
      return {
        thought: `${observation.self.name} advances the current goal through the strongest known relation.`,
        actions: [
          {
            type: "say",
            targetId: closestRelation.to === observation.self.id ? closestRelation.from : closestRelation.to,
            message: `${observation.self.name} proposes cooperation around: ${observation.self.goal}`,
            visibility: "agent",
          },
        ],
      };
    }

    return {
      thought: `${observation.self.name} broadcasts intent because no useful relation is visible yet.`,
      actions: [
        {
          type: "say",
          message: `${observation.self.name} is looking for allies to achieve: ${observation.self.goal}`,
          visibility: "public",
        },
      ],
    };
  }
}

function findLatestMessage(events: WorldEvent[]): (WorldEvent & { actorId: string }) | undefined {
  return [...events]
    .filter(
      (event): event is WorldEvent & { actorId: string } =>
        event.type === "message" && typeof event.actorId === "string" && typeof event.payload.message === "string",
    )
    .sort((a, b) => b.tick - a.tick || b.id.localeCompare(a.id))[0];
}
