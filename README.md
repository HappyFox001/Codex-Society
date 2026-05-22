# Codex Society

TypeScript SDK for running a multi-agent social simulation outside Codex Core.

The current implementation follows route one from the design note: Codex or any LLM runtime is treated as a replaceable agent executor, while the simulator owns world state, ticks, observation projection, events, memory, relations, and action validation.

## CLI Quick Start

Recommended interactive mode:

```bash
pnpm install
pnpm run cli
```

This opens the simulation target workbench:

```text
Codex Society
Simulation target workbench
Use the menu to run an existing target or create a new target template.

Choose action
  1  Simulate target
  2  Create target template
  3  List targets
  4  Exit
Select [1]:
```

Menu flow:

```text
Simulate target -> choose a target from simulations/ -> choose ticks -> run
Create target template -> enter id/title/description -> write simulations/<id>/
```

Command mode remains available for automation:

```bash
pnpm install
pnpm run build
pnpm run cli -- init --template campus
pnpm run cli -- doctor
pnpm run cli -- run --ticks 5 --backend codex
pnpm run cli -- report
```

## Simulation Targets

Targets live under `simulations/`. The first target is Trump-side China pre-visit planning.

Run it from the shell:

```bash
pnpm run cli
```

Then choose `Simulate target`, select `trump-china-previsit`, and accept or edit the tick count.

Interactive simulation artifacts are saved under:

```text
runs/<target-id>/<run-id>/
```

For example:

```text
runs/trump-china-previsit/run_20260521_064849/
```

The main human-readable output is `REPORT.md`. For Codex-backed runs, this report is generated after the simulation by reading the run artifacts and answering the target's core objective in Simplified Chinese with concrete evidence from agent decisions, events, relations and state changes.

After `pnpm run build`, the package exposes two bin names:

```text
codex-society
society
```

Core commands:

```text
codex-society init --template campus
codex-society doctor
codex-society run --ticks 5 --backend codex --save
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

Interactive target runs are stored under `runs/<target-id>/<run-id>/` as JSON/JSONL/Markdown files, so CLI runs are recoverable and scriptable without a frontend. The `runs/` directory is ignored by git.

For Codex-backed target runs, `REPORT.md` is a Simplified Chinese result report. The raw evidence remains available in `events.jsonl`, `ticks/*.json`, `decisions/*/*.json`, `timeline.json`, `graph.json`, and `metrics.json`.

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
  codex-cli-runtime.ts
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
pnpm install
pnpm run dev
```

Validate types:

```bash
pnpm run typecheck
```

Build declarations and JavaScript:

```bash
pnpm run build
```

## OpenAI-Compatible Gateway

The SDK includes a small HTTP gateway so simulator runtimes can talk to Codex, local models, or normal model providers through one OpenAI-style contract.

Start the gateway:

```bash
pnpm run api
```

Available endpoints:

```text
GET  /v1/models
POST /v1/chat/completions
POST /v1/responses
```

Use the Codex CLI backend:

```bash
CODEX_SOCIETY_BACKEND=codex pnpm run api
```

Codex backend defaults to unattended full-access execution:

```text
--dangerously-bypass-approvals-and-sandbox
--sandbox danger-full-access
```

Useful environment variables:

```text
PORT=8787
HOST=127.0.0.1
CODEX_SOCIETY_API_KEY=optional-bearer-token
CODEX_SOCIETY_BACKEND=static | echo | codex
CODEX_SOCIETY_RUNS_DIR=/path/to/output-runs
CODEX_SOCIETY_CODEX_CWD=/path/to/workspace
CODEX_SOCIETY_CODEX_SANDBOX=danger-full-access
CODEX_SOCIETY_CODEX_TIMEOUT_MS=120000
```

The normal CLI simulation path calls Codex directly through `CodexCliRuntime`. The simulator can also call any compatible gateway through `OpenAiCompatibleRuntime`:

```ts
const runtime = new OpenAiCompatibleRuntime({
  baseUrl: "http://127.0.0.1:8787",
  model: "codex-default",
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
