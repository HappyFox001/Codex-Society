import { z } from "zod";
import { actionSchema } from "../core/types.js";

export const backendSchema = z.enum(["static", "openai", "codex", "custom"]);
export const schedulerSchema = z.enum(["round-robin", "one-agent-per-tick"]);

export const societyConfigSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  backend: backendSchema.default("static"),
  model: z.string().default("society-static"),
  gateway: z.string().url().optional(),
  scheduler: schedulerSchema.default("round-robin"),
  continueOnAgentError: z.boolean().default(true),
  logLevel: z.enum(["quiet", "normal", "verbose", "debug"]).default("normal"),
  codex: z
    .object({
      sandbox: z.literal("danger-full-access").default("danger-full-access"),
      approval: z.literal("never").default("never"),
      fullAccess: z.literal(true).default(true),
      timeoutMs: z.number().int().positive().default(120000),
    })
    .default({ sandbox: "danger-full-access", approval: "never", fullAccess: true, timeoutMs: 120000 }),
});

export const agentFileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  role: z.string().min(1),
  personality: z.string().min(1),
  goal: z.string().min(1),
  toolPermissions: z.array(z.string()).default(["say", "remember", "updateRelation", "updateEntity", "noop"]),
  tags: z.array(z.string()).optional(),
  memory: z.object({ facts: z.array(z.string()).default([]), notes: z.array(z.string()).default([]) }).default({
    facts: [],
    notes: [],
  }),
});

export const worldFileSchema = z.object({
  tick: z.number().int().nonnegative().default(0),
  publicFacts: z.array(z.string()).default([]),
  state: z.record(z.unknown()).default({}),
});

export const relationKindSchema = z.enum(["friend", "enemy", "manager", "report", "partner", "stranger", "ally"]);

export const relationFileSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  kind: relationKindSchema,
  trust: z.number().min(-100).max(100).default(0),
  affinity: z.number().min(-100).max(100).default(0),
  metadata: z.record(z.unknown()).optional(),
});

export const entityFileSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  name: z.string().min(1),
  visibility: z.enum(["public", "private", "relation", "agent"]).default("public"),
  visibleTo: z.array(z.string()).optional(),
  relationKinds: z.array(relationKindSchema).optional(),
  state: z.record(z.unknown()).default({}),
});

export const goalFileSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().default(""),
  priority: z.number().int().min(0).default(1),
  successCondition: z.string().default(""),
  deadlineTick: z.number().int().positive().optional(),
});

export const scenarioFileSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  ticks: z.number().int().positive().default(5),
  stopWhen: z.enum(["tick", "goal", "event", "timeout"]).default("tick"),
  inject: z.array(actionSchema).default([]),
});

export type SocietyConfig = z.infer<typeof societyConfigSchema>;
export type AgentFile = z.infer<typeof agentFileSchema>;
export type ProjectWorldFile = z.infer<typeof worldFileSchema>;
export type ProjectRelationFile = z.infer<typeof relationFileSchema>;
export type ProjectEntityFile = z.infer<typeof entityFileSchema>;
export type GoalFile = z.infer<typeof goalFileSchema>;
export type ScenarioFile = z.infer<typeof scenarioFileSchema>;

export interface SocietyProject {
  root: string;
  config: SocietyConfig;
  world: ProjectWorldFile;
  agents: AgentFile[];
  relations: ProjectRelationFile[];
  entities: ProjectEntityFile[];
  goals: GoalFile[];
  scenarios: ScenarioFile[];
}
