# Codex Society

TypeScript SDK for running a multi-agent social simulation outside Codex Core.

The current implementation follows route one from the design note: Codex or any LLM runtime is treated as a replaceable agent executor, while the simulator owns world state, ticks, observation projection, events, memory, relations, and action validation.

## Structure

```text
src/core
  types.ts          Shared domain contracts and action schemas
  world.ts          World state, memory, relations, entities, event writes
  observation.ts    Per-agent observation projection
  scheduler.ts      Tick scheduling strategies
  simulator.ts      Closed-loop simulation orchestration

src/runtime
  agent-runtime.ts  Runtime interface for LLM/Codex adapters
  rule-based-runtime.ts

src/examples
  run-society.ts    Backend script demo
```

## Run

```bash
npm install
npm run dev
```

Validate types:

```bash
npm run typecheck
```

Build declarations and JavaScript:

```bash
npm run build
```

## Core Loop

```text
WorldState snapshot
→ ObservationProjector creates per-agent view
→ AgentRuntime decides actions
→ Simulator validates action schema and tool permissions
→ WorldState applies actions
→ Events, memory, relations, and entities update
→ next tick
```

## Runtime Extension

To connect Codex Thread Runtime, OpenAI SDK, or another LLM executor, implement `AgentRuntime`:

```ts
import type { AgentRuntime, AgentDecision, Observation } from "codex-society";

export class LlmRuntime implements AgentRuntime {
  async decide(observation: Observation): Promise<AgentDecision> {
    // Convert observation into a prompt, call your model/runtime,
    // parse structured actions, and return AgentDecision.
    return {
      thought: "model reasoning summary",
      actions: [{ type: "noop", reason: "not implemented" }],
    };
  }
}
```

The simulator does not trust runtime output blindly. Actions are parsed through Zod and checked against each agent's `toolPermissions` before they can mutate world state.

## Current Capabilities

- Independent agent profiles with role, personality, goal, memory, and permissions
- Directed relations with trust and affinity
- Public, private, relation-scoped, and agent-scoped visibility
- Event log as the world mutation history
- Per-agent observation projection to preserve information asymmetry
- Pluggable scheduling strategy
- Runtime error isolation via `continueOnAgentError`

## Next Engineering Step

The next useful layer is a real LLM runtime adapter that maps `Observation` to structured `AgentDecision`, ideally with provider-specific modules kept outside `src/core`.
