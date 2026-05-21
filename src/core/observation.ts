import type {
  AgentId,
  Observation,
  Relation,
  Visibility,
  WorldEntity,
  WorldEvent,
  WorldStateSnapshot,
} from "./types.js";

export interface ObservationProjector {
  project(snapshot: WorldStateSnapshot, agentId: AgentId): Observation;
}

export class DefaultObservationProjector implements ObservationProjector {
  project(snapshot: WorldStateSnapshot, agentId: AgentId): Observation {
    const self = snapshot.agents.find((agent) => agent.id === agentId);
    if (!self) {
      throw new Error(`Unknown agent: ${agentId}`);
    }

    return {
      tick: snapshot.tick,
      self,
      memory: snapshot.memory[agentId] ?? { facts: [], notes: [] },
      visibleAgents: snapshot.agents.filter((agent) => agent.id !== agentId),
      visibleEntities: snapshot.entities.filter((entity) =>
        isVisible(entity.visibility, agentId, snapshot.relations, entity.visibleTo, entity.relationKinds),
      ),
      visibleRelations: snapshot.relations.filter((relation) => relation.from === agentId || relation.to === agentId),
      visibleEvents: snapshot.events.filter((event) =>
        isVisible(event.visibility, agentId, snapshot.relations, event.visibleTo, event.relationKinds),
      ),
    };
  }
}

function isVisible(
  visibility: Visibility,
  agentId: AgentId,
  relations: Relation[],
  visibleTo?: AgentId[],
  relationKinds?: string[],
): boolean {
  if (visibility === "public") {
    return true;
  }

  if (visibility === "agent") {
    return visibleTo?.includes(agentId) ?? false;
  }

  if (visibility === "private") {
    return visibleTo?.includes(agentId) ?? false;
  }

  if (visibility === "relation") {
    return relations.some(
      (relation) =>
        relation.from === agentId &&
        (!relationKinds || relationKinds.includes(relation.kind)) &&
        (!visibleTo || visibleTo.includes(relation.to)),
    );
  }

  return false;
}
