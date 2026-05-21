import type { AgentFile, GoalFile, ProjectEntityFile, ProjectRelationFile, ProjectWorldFile, ScenarioFile, SocietyConfig } from "./schemas.js";

export type TemplateName = "minimal" | "town" | "campus" | "market";

export interface SocietyTemplate {
  name: TemplateName;
  description: string;
  config: SocietyConfig;
  world: ProjectWorldFile;
  agents: AgentFile[];
  relations: ProjectRelationFile[];
  entities: ProjectEntityFile[];
  goals: GoalFile[];
  scenarios: ScenarioFile[];
}

const defaultPermissions = ["say", "remember", "updateRelation", "updateEntity", "noop"];

export function listTemplates(): SocietyTemplate[] {
  return [minimalTemplate(), townTemplate(), campusTemplate(), marketTemplate()];
}

export function getTemplate(name: string): SocietyTemplate {
  const template = listTemplates().find((item) => item.name === name);
  if (!template) {
    throw new Error(`Unknown template: ${name}`);
  }
  return template;
}

function baseConfig(name: TemplateName, description: string): SocietyConfig {
  return {
    name,
    description,
    backend: "static",
    model: "society-static",
    scheduler: "round-robin",
    continueOnAgentError: true,
    logLevel: "normal",
    codex: { sandbox: "danger-full-access", approval: "never", fullAccess: true, timeoutMs: 120000 },
  };
}

function minimalTemplate(): SocietyTemplate {
  return {
    name: "minimal",
    description: "Two agents in a small public room.",
    config: baseConfig("minimal", "A minimal society simulation."),
    world: { tick: 0, publicFacts: ["A small meeting is starting."], state: { location: "meeting-room" } },
    agents: [
      agent("alice", "Alice", "coordinator", "calm and cooperative", "build shared agreement"),
      agent("bob", "Bob", "operator", "practical and skeptical", "verify whether the plan is useful"),
    ],
    relations: [{ from: "alice", to: "bob", kind: "partner", trust: 20, affinity: 10 }],
    entities: [{ id: "room", type: "place", name: "Meeting Room", visibility: "public", state: { mood: "quiet" } }],
    goals: [goal("consensus", "Reach consensus", "Agents exchange enough information to align on a plan.")],
    scenarios: [scenario("default", 5)],
  };
}

function townTemplate(): SocietyTemplate {
  const template = minimalTemplate();
  return {
    ...template,
    name: "town",
    description: "A town square with local information flow.",
    config: baseConfig("town", "A town-scale social simulation."),
    world: { tick: 0, publicFacts: ["A town debate begins at sunset."], state: { location: "town-square" } },
    agents: [
      agent("mayor", "Mayor Lin", "mayor", "diplomatic and cautious", "keep the town stable"),
      agent("merchant", "Mara", "merchant", "resourceful and pragmatic", "secure trade commitments"),
      agent("reporter", "Chen", "reporter", "curious and careful", "discover which faction is gaining influence"),
    ],
    relations: [
      { from: "mayor", to: "merchant", kind: "partner", trust: 18, affinity: 8 },
      { from: "reporter", to: "mayor", kind: "stranger", trust: 6, affinity: 2 },
    ],
    entities: [
      { id: "notice_board", type: "place", name: "Notice Board", visibility: "public", state: { topic: "Water rights" } },
    ],
  };
}

function campusTemplate(): SocietyTemplate {
  return {
    ...townTemplate(),
    name: "campus",
    description: "A campus society with organizers, stakeholders, and public opinion.",
    config: baseConfig("campus", "A campus social simulation."),
    world: { tick: 0, publicFacts: ["A climate proposal is being discussed."], state: { location: "campus" } },
    agents: [
      agent("alice", "Alice", "student leader", "calm, strategic, cooperative", "build consensus for a campus climate proposal"),
      agent("bob", "Bob", "merchant", "pragmatic, resource-driven, skeptical", "gain access to reliable community resources"),
      agent("chen", "Chen", "local journalist", "curious, careful, socially observant", "discover which proposal is gaining influence"),
    ],
    relations: [
      { from: "alice", to: "bob", kind: "partner", trust: 24, affinity: 18 },
      { from: "bob", to: "alice", kind: "partner", trust: 18, affinity: 12 },
      { from: "chen", to: "alice", kind: "stranger", trust: 4, affinity: 2 },
    ],
    entities: [
      { id: "notice_board", type: "place", name: "Town Notice Board", visibility: "public", state: { topic: "A public debate is scheduled tonight." } },
      { id: "alice_private_note", type: "secret", name: "Alice Private Note", visibility: "agent", visibleTo: ["alice"], state: { content: "Bob needs public credibility before committing resources." } },
    ],
    goals: [goal("proposal", "Move proposal forward", "At least two agents increase trust around the proposal.")],
    scenarios: [scenario("default", 5)],
  };
}

function marketTemplate(): SocietyTemplate {
  return {
    ...townTemplate(),
    name: "market",
    description: "A market with negotiation and reputation dynamics.",
    config: baseConfig("market", "A market social simulation."),
    world: { tick: 0, publicFacts: ["Supply is scarce and buyers are negotiating."], state: { location: "market" } },
  };
}

function agent(id: string, name: string, role: string, personality: string, goal: string): AgentFile {
  return { id, name, role, personality, goal, toolPermissions: defaultPermissions, memory: { facts: [], notes: [] } };
}

function goal(id: string, title: string, successCondition: string): GoalFile {
  return { id, title, description: successCondition, priority: 1, successCondition };
}

function scenario(name: string, ticks: number): ScenarioFile {
  return { name, description: `Run ${ticks} ticks.`, ticks, stopWhen: "tick", inject: [] };
}
