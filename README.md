# Codex Society

TypeScript SDK for running a multi-agent social simulation outside Codex Core.

The current implementation follows route one from the design note: Codex or any LLM runtime is treated as a replaceable agent executor, while the simulator owns world state, ticks, observation projection, events, memory, relations, and action validation.

## CLI Quick Start

```bash
npm install
npm run build
npm run cli -- init --template campus
npm run cli -- doctor
npm run cli -- run --ticks 5 --backend static
npm run cli -- report
```

After `npm run build`, the package exposes two bin names:

```text
codex-society
society
```

Core commands:

```text
codex-society init --template campus
codex-society doctor
codex-society run --ticks 5 --backend static --save
codex-society observe alice --json
codex-society report <run-id>
codex-society replay <run-id>
codex-society export <run-id> --format json
codex-society serve --backend codex --port 8787
codex-society run --ticks 5 --gateway http://127.0.0.1:8787
```

Project layout created by `init`:

```text
.society/
  manifest.json
  config.json
  runs/
  logs/
  status/
society/
  world.json
  agents/
  relations.json
  entities.json
  goals.json
  tools.json
  scenarios/
SOCIETY_GUIDE.md
```

Run artifacts are stored under `.society/runs/<run-id>/` as JSON/JSONL/Markdown files, so CLI runs are recoverable and scriptable without a frontend.

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
  openai-compatible-runtime.ts
  rule-based-runtime.ts

src/project
  schemas.ts        Project file schemas
  templates.ts      Built-in society templates
  store.ts          Project loading and persistence
  artifacts.ts      Run artifact contract

src/cli
  main.ts           CLI entrypoint
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

## OpenAI-Compatible Gateway

The SDK includes a small HTTP gateway so simulator runtimes can talk to Codex, local models, or normal model providers through one OpenAI-style contract.

Start the default static backend:

```bash
npm run api
```

Available endpoints:

```text
GET  /v1/models
POST /v1/chat/completions
POST /v1/responses
```

Use the Codex CLI backend:

```bash
CODEX_SOCIETY_BACKEND=codex npm run api
```

Codex backend defaults to unattended full-access execution:

```text
--ask-for-approval never
--dangerously-bypass-approvals-and-sandbox
--sandbox danger-full-access
```

Useful environment variables:

```text
PORT=8787
HOST=127.0.0.1
CODEX_SOCIETY_API_KEY=optional-bearer-token
CODEX_SOCIETY_BACKEND=static | echo | codex
CODEX_SOCIETY_CODEX_CWD=/path/to/workspace
CODEX_SOCIETY_CODEX_SANDBOX=danger-full-access
CODEX_SOCIETY_CODEX_TIMEOUT_MS=120000
```

The simulator can call any compatible gateway through `OpenAiCompatibleRuntime`:

```ts
const runtime = new OpenAiCompatibleRuntime({
  baseUrl: "http://127.0.0.1:8787",
  model: "society-static",
});
```

This keeps the shape future-proof: the simulator depends on an OpenAI-compatible API, while Codex-specific execution is isolated behind a backend adapter.

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

To connect Codex Thread Runtime, OpenAI SDK, or another LLM executor directly, implement `AgentRuntime`:

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
