import type { AgentId, EventId, RelationKind, Tick, Visibility, WorldEvent } from "./types.js";

let nextEventNumber = 1;

export interface EventInput {
  tick: Tick;
  type: string;
  actorId?: AgentId;
  targetId?: AgentId;
  payload?: Record<string, unknown>;
  visibility?: Visibility;
  visibleTo?: AgentId[];
  relationKinds?: RelationKind[];
}

export function createEvent(input: EventInput): WorldEvent {
  return {
    id: createEventId(),
    tick: input.tick,
    type: input.type,
    actorId: input.actorId,
    targetId: input.targetId,
    payload: input.payload ?? {},
    visibility: input.visibility ?? "public",
    visibleTo: input.visibleTo,
    relationKinds: input.relationKinds,
  };
}

function createEventId(): EventId {
  return `event_${nextEventNumber++}`;
}
