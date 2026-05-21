import { z } from "zod";

export type AgentId = string;
export type EntityId = string;
export type EventId = string;
export type Tick = number;

export type RelationKind =
  | "friend"
  | "enemy"
  | "manager"
  | "report"
  | "partner"
  | "stranger"
  | "ally";

export type Visibility = "public" | "private" | "relation" | "agent";

export interface AgentProfile {
  id: AgentId;
  name: string;
  role: string;
  personality: string;
  goal: string;
  toolPermissions: string[];
  tags?: string[];
}

export interface AgentMemory {
  facts: string[];
  notes: string[];
}

export interface Relation {
  from: AgentId;
  to: AgentId;
  kind: RelationKind;
  trust: number;
  affinity: number;
  metadata?: Record<string, unknown>;
}

export interface WorldEntity {
  id: EntityId;
  type: string;
  name: string;
  state: Record<string, unknown>;
  visibility: Visibility;
  visibleTo?: AgentId[];
  relationKinds?: RelationKind[];
}

export interface WorldEvent {
  id: EventId;
  tick: Tick;
  type: string;
  actorId?: AgentId;
  targetId?: AgentId;
  payload: Record<string, unknown>;
  visibility: Visibility;
  visibleTo?: AgentId[];
  relationKinds?: RelationKind[];
}

export interface WorldStateSnapshot {
  tick: Tick;
  agents: AgentProfile[];
  entities: WorldEntity[];
  relations: Relation[];
  events: WorldEvent[];
  memory: Record<AgentId, AgentMemory>;
}

export interface Observation {
  tick: Tick;
  self: AgentProfile;
  memory: AgentMemory;
  visibleAgents: AgentProfile[];
  visibleEntities: WorldEntity[];
  visibleRelations: Relation[];
  visibleEvents: WorldEvent[];
}

export const actionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("say"),
    targetId: z.string().optional(),
    message: z.string().min(1),
    visibility: z.enum(["public", "private", "relation", "agent"]).default("public"),
  }),
  z.object({
    type: z.literal("remember"),
    fact: z.string().min(1),
  }),
  z.object({
    type: z.literal("updateRelation"),
    targetId: z.string(),
    trustDelta: z.number().default(0),
    affinityDelta: z.number().default(0),
  }),
  z.object({
    type: z.literal("updateEntity"),
    entityId: z.string(),
    patch: z.record(z.unknown()),
  }),
  z.object({
    type: z.literal("noop"),
    reason: z.string().optional(),
  }),
]);

export type AgentAction = z.infer<typeof actionSchema>;

export interface AgentDecision {
  thought: string;
  actions: AgentAction[];
}

export interface SimulationReport {
  tick: Tick;
  decisions: Array<{
    agentId: AgentId;
    decision: AgentDecision;
  }>;
  events: WorldEvent[];
}
