import { createEvent } from "./events.js";
import type {
  AgentAction,
  AgentId,
  AgentMemory,
  AgentProfile,
  Relation,
  WorldEntity,
  WorldEvent,
  WorldStateSnapshot,
} from "./types.js";

export interface WorldConfig {
  tick?: number;
  agents: AgentProfile[];
  entities?: WorldEntity[];
  relations?: Relation[];
  memory?: Record<AgentId, AgentMemory>;
  events?: WorldEvent[];
}

export class WorldState {
  private tickValue = 0;
  private readonly agents = new Map<AgentId, AgentProfile>();
  private readonly entities = new Map<string, WorldEntity>();
  private readonly relations = new Map<string, Relation>();
  private readonly memory = new Map<AgentId, AgentMemory>();
  private readonly events: WorldEvent[] = [];

  constructor(config: WorldConfig) {
    this.tickValue = config.tick ?? 0;
    for (const agent of config.agents) {
      this.agents.set(agent.id, agent);
      this.memory.set(agent.id, config.memory?.[agent.id] ?? { facts: [], notes: [] });
    }

    for (const entity of config.entities ?? []) {
      this.entities.set(entity.id, entity);
    }

    for (const relation of config.relations ?? []) {
      this.relations.set(relationKey(relation.from, relation.to), relation);
    }

    this.events.push(...(config.events ?? []));
  }

  get tick(): number {
    return this.tickValue;
  }

  getAgent(agentId: AgentId): AgentProfile {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new Error(`Unknown agent: ${agentId}`);
    }
    return agent;
  }

  getAgents(): AgentProfile[] {
    return [...this.agents.values()];
  }

  getMemory(agentId: AgentId): AgentMemory {
    const memory = this.memory.get(agentId);
    if (!memory) {
      throw new Error(`Unknown memory owner: ${agentId}`);
    }
    return {
      facts: [...memory.facts],
      notes: [...memory.notes],
    };
  }

  getRelation(from: AgentId, to: AgentId): Relation | undefined {
    return this.relations.get(relationKey(from, to));
  }

  snapshot(): WorldStateSnapshot {
    return {
      tick: this.tickValue,
      agents: this.getAgents(),
      entities: [...this.entities.values()].map(cloneEntity),
      relations: [...this.relations.values()].map((relation) => ({ ...relation })),
      events: this.events.map((event) => ({ ...event, payload: { ...event.payload } })),
      memory: Object.fromEntries(
        [...this.memory.entries()].map(([agentId, memory]) => [
          agentId,
          { facts: [...memory.facts], notes: [...memory.notes] },
        ]),
      ),
    };
  }

  advanceTick(): number {
    this.tickValue += 1;
    return this.tickValue;
  }

  applyAction(agentId: AgentId, action: AgentAction): WorldEvent | undefined {
    this.getAgent(agentId);

    switch (action.type) {
      case "say":
        return this.recordEvent({
          type: "message",
          actorId: agentId,
          targetId: action.targetId,
          payload: { message: action.message },
          visibility: action.visibility,
          visibleTo: action.visibility === "agent" && action.targetId ? [agentId, action.targetId] : undefined,
        });

      case "remember": {
        const memory = this.memory.get(agentId);
        if (!memory) {
          throw new Error(`Unknown memory owner: ${agentId}`);
        }
        memory.facts.push(action.fact);
        return this.recordEvent({
          type: "memory.recorded",
          actorId: agentId,
          payload: { fact: action.fact },
          visibility: "agent",
          visibleTo: [agentId],
        });
      }

      case "updateRelation": {
        const current =
          this.getRelation(agentId, action.targetId) ??
          ({
            from: agentId,
            to: action.targetId,
            kind: "stranger",
            trust: 0,
            affinity: 0,
          } satisfies Relation);

        const next = {
          ...current,
          trust: clampRelationScore(current.trust + action.trustDelta),
          affinity: clampRelationScore(current.affinity + action.affinityDelta),
        };
        this.relations.set(relationKey(agentId, action.targetId), next);

        return this.recordEvent({
          type: "relation.updated",
          actorId: agentId,
          targetId: action.targetId,
          payload: {
            trust: next.trust,
            affinity: next.affinity,
            trustDelta: action.trustDelta,
            affinityDelta: action.affinityDelta,
          },
          visibility: "agent",
          visibleTo: [agentId, action.targetId],
        });
      }

      case "updateEntity": {
        const entity = this.entities.get(action.entityId);
        if (!entity) {
          throw new Error(`Unknown entity: ${action.entityId}`);
        }
        const next = {
          ...entity,
          state: { ...entity.state, ...action.patch },
        };
        this.entities.set(action.entityId, next);
        return this.recordEvent({
          type: "entity.updated",
          actorId: agentId,
          payload: { entityId: action.entityId, patch: action.patch },
          visibility: next.visibility,
          visibleTo: next.visibleTo,
          relationKinds: next.relationKinds,
        });
      }

      case "noop":
        return this.recordEvent({
          type: "agent.noop",
          actorId: agentId,
          payload: { reason: action.reason },
          visibility: "agent",
          visibleTo: [agentId],
        });
    }
  }

  private recordEvent(input: Omit<Parameters<typeof createEvent>[0], "tick">): WorldEvent {
    const event = createEvent({ tick: this.tickValue, ...input });
    this.events.push(event);
    return event;
  }
}

export function relationKey(from: AgentId, to: AgentId): string {
  return `${from}->${to}`;
}

function cloneEntity(entity: WorldEntity): WorldEntity {
  return {
    ...entity,
    state: { ...entity.state },
    visibleTo: entity.visibleTo ? [...entity.visibleTo] : undefined,
    relationKinds: entity.relationKinds ? [...entity.relationKinds] : undefined,
  };
}

function clampRelationScore(value: number): number {
  return Math.max(-100, Math.min(100, value));
}
