import {
  RuleBasedRuntime,
  SocietySimulator,
  WorldState,
  type AgentProfile,
  type Relation,
  type WorldEntity,
} from "../index.js";

const agents: AgentProfile[] = [
  {
    id: "alice",
    name: "Alice",
    role: "student leader",
    personality: "calm, strategic, cooperative",
    goal: "build consensus for a campus climate proposal",
    toolPermissions: ["say", "remember", "updateRelation"],
  },
  {
    id: "bob",
    name: "Bob",
    role: "merchant",
    personality: "pragmatic, resource-driven, skeptical",
    goal: "gain access to reliable community resources",
    toolPermissions: ["say", "remember", "updateRelation"],
  },
  {
    id: "chen",
    name: "Chen",
    role: "local journalist",
    personality: "curious, careful, socially observant",
    goal: "discover which proposal is gaining influence",
    toolPermissions: ["say", "remember", "updateRelation"],
  },
];

const relations: Relation[] = [
  { from: "alice", to: "bob", kind: "partner", trust: 24, affinity: 18 },
  { from: "bob", to: "alice", kind: "partner", trust: 18, affinity: 12 },
  { from: "chen", to: "alice", kind: "stranger", trust: 4, affinity: 2 },
];

const entities: WorldEntity[] = [
  {
    id: "notice_board",
    type: "place",
    name: "Town Notice Board",
    visibility: "public",
    state: {
      topic: "A public debate is scheduled tonight.",
    },
  },
  {
    id: "alice_private_note",
    type: "secret",
    name: "Alice Private Note",
    visibility: "agent",
    visibleTo: ["alice"],
    state: {
      content: "Alice knows Bob needs public credibility before he commits resources.",
    },
  },
];

const world = new WorldState({
  agents,
  relations,
  entities,
  memory: {
    alice: { facts: ["Bob responds well to practical commitments."], notes: [] },
    bob: { facts: ["Alice can mobilize student groups."], notes: [] },
    chen: { facts: ["Public opinion is fragmented."], notes: [] },
  },
});

const simulator = new SocietySimulator({
  world,
  runtime: new RuleBasedRuntime(),
  continueOnAgentError: true,
});

const reports = await simulator.runTicks(4);

for (const report of reports) {
  console.log(`\nTick ${report.tick}`);
  for (const decision of report.decisions) {
    console.log(`- ${decision.agentId}: ${decision.decision.thought}`);
    for (const action of decision.decision.actions) {
      console.log(`  action: ${action.type}`);
    }
  }
  for (const event of report.events) {
    console.log(`  event: ${event.type} ${event.actorId ?? ""} -> ${event.targetId ?? "world"}`);
  }
}

console.log("\nFinal snapshot");
const snapshot = simulator.snapshot();
console.log(
  JSON.stringify(
    {
      tick: snapshot.tick,
      relations: snapshot.relations,
      memory: snapshot.memory,
      eventCount: snapshot.events.length,
    },
    null,
    2,
  ),
);
