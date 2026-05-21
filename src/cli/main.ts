#!/usr/bin/env node
import { Command } from "commander";
import pc from "picocolors";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  CodexCliBackend,
  EchoBackend,
  OpenAiCompatibleRuntime,
  RuleBasedRuntime,
  SocietySimulator,
  StaticDecisionBackend,
  startOpenAiCompatibleServer,
} from "../index.js";
import { DefaultObservationProjector } from "../core/observation.js";
import { OneAgentPerTickSchedule, RoundRobinSchedule } from "../core/scheduler.js";
import {
  acquireRunLock,
  createRunId,
  finishRun,
  latestRunId,
  releaseRunLock,
  runDir,
  startRun,
  writeRunError,
  writeDerivedArtifacts,
  writeTickArtifact,
  type RunManifest,
} from "../project/artifacts.js";
import { generateReport } from "../project/report.js";
import { agentFileSchema, entityFileSchema, relationFileSchema } from "../project/schemas.js";
import { getTemplate, listTemplates, type SocietyTemplate } from "../project/templates.js";
import { exists, initProject, loadProject, readJson, saveProjectWorld, SOCIETY_DIR, toWorldState, writeJson } from "../project/store.js";

const program = new Command();

program
  .name("codex-society")
  .description("Build, run, and inspect Codex Society simulations.")
  .version("0.1.0")
  .option("--json", "emit machine-readable JSON")
  .option("--quiet", "reduce output")
  .option("--verbose", "print verbose output")
  .option("--no-color", "disable color");

program
  .command("init")
  .description("create a society project")
  .option("-t, --template <name>", "template name", "minimal")
  .option("--template-dir <path>", "directory containing template.json")
  .option("--dry-run", "show files without writing")
  .action(async (options) => {
    const root = process.cwd();
    const template = options.templateDir
      ? (await readJson(join(resolve(options.templateDir), "template.json")) as SocietyTemplate)
      : getTemplate(options.template);
    const files = await initProject(root, template, { dryRun: options.dryRun });
    output({ created: files }, options.dryRun ? `Would create ${files.length} files.` : `Created ${pc.green(template.name)} society project.`);
  });

program
  .command("doctor")
  .description("validate the current society project")
  .action(async () => {
    const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
    for (const path of [".society/config.json", "society/world.json", "society/agents", "society/relations.json"]) {
      checks.push({ name: path, ok: await exists(resolve(path)) });
    }
    try {
      const project = await loadProject(process.cwd());
      checks.push({ name: "schemas", ok: true, detail: `${project.agents.length} agents` });
    } catch (error) {
      checks.push({ name: "schemas", ok: false, detail: errorMessage(error) });
    }
    const ok = checks.every((check) => check.ok);
    output({ ok, checks }, checks.map((check) => `${check.ok ? pc.green("OK") : pc.red("FAIL")} ${check.name}${check.detail ? ` ${check.detail}` : ""}`).join("\n"));
    if (!ok) process.exitCode = 1;
  });

program
  .command("run")
  .description("run a society simulation")
  .option("--ticks <n>", "ticks to run", parseIntOption, 5)
  .option("--scenario <name>", "scenario name")
  .option("--backend <name>", "static|openai|codex|custom")
  .option("--model <model>", "model name")
  .option("--gateway <url>", "OpenAI-compatible gateway URL")
  .option("--save", "persist run artifacts", true)
  .option("--stream", "stream compact progress", true)
  .option("--resume <runId>", "resume a previous run")
  .option("--until <mode>", "goal|tick|event|timeout", "tick")
  .option("--full-access", "run Codex backend with full access")
  .option("--clear-stale-lock", "clear stale run lock before running")
  .action(async (options) => {
    const project = await loadProject(process.cwd());
    const scenario = options.scenario ? project.scenarios.find((item) => item.name === options.scenario) : undefined;
    if (options.scenario && !scenario) throw new Error(`Unknown scenario: ${options.scenario}`);
    const ticks = Number(options.ticks ?? scenario?.ticks ?? 5);
    const backend = options.backend ?? (options.gateway ? "custom" : project.config.backend);
    const model = options.model ?? project.config.model;
    const runtime = options.gateway
      ? new OpenAiCompatibleRuntime({ baseUrl: options.gateway, model })
      : backend === "static"
        ? new RuleBasedRuntime()
        : new OpenAiCompatibleRuntime({ baseUrl: project.config.gateway ?? "http://127.0.0.1:8787", model });
    const world = toWorldState(project);
    const simulator = new SocietySimulator({
      world,
      runtime,
      continueOnAgentError: project.config.continueOnAgentError,
      schedule: project.config.scheduler === "one-agent-per-tick" ? new OneAgentPerTickSchedule() : new RoundRobinSchedule(),
    });
    const runId = options.resume ?? createRunId();
    let lockPath: string | undefined;
    let interrupted = false;
    const manifest: RunManifest = { id: runId, status: "running", backend, model, ticksRequested: ticks, startedAt: new Date().toISOString() };
    lockPath = await acquireRunLock(process.cwd(), runId, Boolean(options.clearStaleLock));
    const dir = await startRun(process.cwd(), manifest);
    const onSigint = () => {
      interrupted = true;
    };
    process.once("SIGINT", onSigint);
    try {
      for (let i = 0; i < ticks; i += 1) {
        if (interrupted) break;
        const report = await simulator.runTick();
        const snapshot = simulator.snapshot();
        await writeTickArtifact(dir, report, snapshot);
        if (options.stream) printTick(report);
      }
      await saveProjectWorld(process.cwd(), world);
      const snapshot = simulator.snapshot();
      await writeDerivedArtifacts(dir, snapshot);
      await finishRun(dir, { status: interrupted ? "interrupted" : "completed", endedAt: new Date().toISOString() });
      await generateReport(dir);
      output({ runId, dir, interrupted }, `${interrupted ? "Interrupted" : "Completed"} ${pc.green(runId)} at ${dir}`);
    } catch (error) {
      await writeRunError(dir, error);
      await finishRun(dir, { status: "failed", endedAt: new Date().toISOString(), error: errorMessage(error) });
      throw error;
    } finally {
      process.off("SIGINT", onSigint);
      await releaseRunLock(lockPath);
    }
  });

program.command("report").argument("[runId]").description("generate or print a run report").action(async (runId?: string) => {
  const id = runId ?? (await latestRunId(process.cwd()));
  if (!id) throw new Error("No run found.");
  const report = await generateReport(runDir(process.cwd(), id));
  output({ runId: id, report }, report);
});

program.command("replay").argument("[runId]").description("replay events for a run").action(async (runId?: string) => {
  const id = runId ?? (await latestRunId(process.cwd()));
  if (!id) throw new Error("No run found.");
  const path = join(runDir(process.cwd(), id), "events.jsonl");
  const raw = await readFile(path, "utf8");
  output({ runId: id, events: raw.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as unknown) }, raw);
});

program.command("export").argument("[runId]").option("--format <format>", "json|md", "json").description("export a run").action(async (runId?: string, options?: { format: string }) => {
  const id = runId ?? (await latestRunId(process.cwd()));
  if (!id) throw new Error("No run found.");
  const dir = runDir(process.cwd(), id);
  if (options?.format === "md") {
    output({ runId: id, format: "md" }, await generateReport(dir));
    return;
  }
  output({
    run: await readJson(join(dir, "run.json")),
    metrics: await readJson(join(dir, "metrics.json")),
    timeline: await readJson(join(dir, "timeline.json")),
    graph: await readJson(join(dir, "graph.json")),
  });
});

program.command("inspect").argument("[runId]").option("--agent <id>", "agent id").description("inspect run details").action(async (runId?: string, options?: { agent?: string }) => {
  const id = runId ?? (await latestRunId(process.cwd()));
  if (!id) throw new Error("No run found.");
  const dir = runDir(process.cwd(), id);
  if (options?.agent) {
    output({ agent: options.agent, decisionsDir: join(dir, "decisions") });
    return;
  }
  output({ run: await readJson(join(dir, "run.json")), metrics: await readJson(join(dir, "metrics.json")) });
});

program.command("repair").argument("[runId]").description("rebuild derived artifacts for a run from latest snapshot").action(async (runId?: string) => {
  const id = runId ?? (await latestRunId(process.cwd()));
  if (!id) throw new Error("No run found.");
  const dir = runDir(process.cwd(), id);
  const manifest = await readJson(join(dir, "run.json")) as { ticksRequested?: number };
  const latestTick = manifest.ticksRequested ?? 0;
  const snapshot = await readJson(join(dir, "snapshots", `${latestTick}.json`));
  await writeDerivedArtifacts(dir, snapshot as never);
  await generateReport(dir);
  output({ repaired: id }, `Repaired ${id}`);
});

program.command("observe").argument("<agentId>").description("print current observation for an agent").action(async (agentId) => {
  const project = await loadProject(process.cwd());
  const projector = new DefaultObservationProjector();
  output(projector.project(toWorldState(project).snapshot(), agentId));
});

program.command("status").description("show latest run status").action(async () => {
  const id = await latestRunId(process.cwd());
  if (!id) throw new Error("No run found.");
  output(await readJson(join(runDir(process.cwd(), id), "run.json")));
});

program.command("watch").description("show current status once; suitable for polling").action(async () => {
  const id = await latestRunId(process.cwd());
  if (!id) throw new Error("No run found.");
  output(await readJson(join(runDir(process.cwd(), id), "run.json")));
});

program.command("serve").description("start OpenAI-compatible gateway").option("--backend <name>", "static|echo|codex", "static").option("--port <n>", "port", parseIntOption, 8787).option("--host <host>", "host", "127.0.0.1").action(async (options) => {
  const backend = options.backend === "codex" ? new CodexCliBackend() : options.backend === "echo" ? new EchoBackend() : new StaticDecisionBackend();
  await startOpenAiCompatibleServer({ backend, port: options.port, host: options.host });
});

program.command("models").description("list gateway models").option("--gateway <url>", "gateway URL", "http://127.0.0.1:8787").action(async (options) => {
  const response = await fetch(`${options.gateway}/v1/models`);
  output(await response.json());
});

program.command("ping").description("test gateway health").option("--gateway <url>", "gateway URL", "http://127.0.0.1:8787").option("--model <model>", "model", "society-static").action(async (options) => {
  const response = await fetch(`${options.gateway}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: options.model, messages: [{ role: "user", content: "ping" }] }),
  });
  output(await response.json());
});

const agent = program.command("agent").description("manage agents");
agent.command("list").action(async () => output((await loadProject(process.cwd())).agents));
agent.command("show").argument("<id>").action(async (id) => output(findById((await loadProject(process.cwd())).agents, id)));
agent.command("create").requiredOption("--id <id>").requiredOption("--name <name>").requiredOption("--role <role>").requiredOption("--personality <text>").requiredOption("--goal <goal>").option("--dry-run", "preview without writing").action(async (options) => {
  const parsed = agentFileSchema.parse({ ...options, toolPermissions: ["say", "remember", "updateRelation", "updateEntity", "noop"], memory: { facts: [], notes: [] } });
  if (options.dryRun) {
    output(parsed, JSON.stringify(parsed, null, 2));
    return;
  }
  await writeJson(join(process.cwd(), SOCIETY_DIR, "agents", `${parsed.id}.json`), parsed);
  output(parsed, `Created agent ${pc.green(parsed.id)}`);
});
agent.command("edit").argument("<id>").requiredOption("--set <path>").requiredOption("--value <json>").action(async (id, options) => {
  const path = join(process.cwd(), SOCIETY_DIR, "agents", `${id}.json`);
  const current = agentFileSchema.parse(await readJson(path));
  const next = agentFileSchema.parse(setPath(current, options.set, JSON.parse(options.value)));
  await writeJson(path, next);
  output(next, `Updated agent ${id}`);
});
agent.command("import").argument("<file>").action(async (file) => {
  const parsed = agentFileSchema.parse(await readJson(resolve(file)));
  await writeJson(join(process.cwd(), SOCIETY_DIR, "agents", `${parsed.id}.json`), parsed);
  output(parsed, `Imported agent ${parsed.id}`);
});
agent.command("export").argument("<id>").action(async (id) => {
  output(agentFileSchema.parse(await readJson(join(process.cwd(), SOCIETY_DIR, "agents", `${id}.json`))));
});
agent.command("remove").argument("<id>").action(async (id) => {
  const path = join(process.cwd(), SOCIETY_DIR, "agents", `${id}.json`);
  await unlink(path);
  output({ removed: id }, `Removed agent ${id}`);
});
agent.command("memory").argument("<id>").action(async (id) => output(findById((await loadProject(process.cwd())).agents, id).memory));
agent.command("remember").argument("<id>").argument("<fact>").action(async (id, fact) => {
  const path = join(process.cwd(), SOCIETY_DIR, "agents", `${id}.json`);
  const current = agentFileSchema.parse(await readJson(path));
  current.memory.facts.push(fact);
  await writeJson(path, current);
  output(current.memory, `Updated memory for ${id}`);
});
agent.command("permissions").argument("<id>").argument("[permissions...]").action(async (id, permissions: string[]) => {
  const path = join(process.cwd(), SOCIETY_DIR, "agents", `${id}.json`);
  const current = agentFileSchema.parse(await readJson(path));
  if (permissions.length) {
    current.toolPermissions = permissions;
    await writeJson(path, current);
  }
  output(current.toolPermissions);
});

const relation = program.command("relation").description("manage relations");
relation.command("list").action(async () => output((await loadProject(process.cwd())).relations));
relation.command("set").argument("<from>").argument("<to>").option("--kind <kind>", "relation kind", "stranger").option("--trust <n>", "trust", parseIntOption, 0).option("--affinity <n>", "affinity", parseIntOption, 0).option("--dry-run", "preview without writing").action(async (from, to, options) => {
  const project = await loadProject(process.cwd());
  const next = relationFileSchema.parse({ from, to, kind: options.kind, trust: options.trust, affinity: options.affinity });
  const relations = project.relations.filter((item) => !(item.from === from && item.to === to)).concat([next]);
  if (options.dryRun) {
    output({ before: project.relations, after: relations });
    return;
  }
  await writeJson(join(process.cwd(), SOCIETY_DIR, "relations.json"), relations);
  output(next, `Set relation ${from}->${to}`);
});
relation.command("remove").argument("<from>").argument("<to>").action(async (from, to) => {
  const project = await loadProject(process.cwd());
  await writeJson(join(process.cwd(), SOCIETY_DIR, "relations.json"), project.relations.filter((item) => !(item.from === from && item.to === to)));
  output({ removed: `${from}->${to}` });
});

const entity = program.command("entity").description("manage entities");
entity.command("list").action(async () => output((await loadProject(process.cwd())).entities));
entity.command("create").requiredOption("--id <id>").requiredOption("--type <type>").requiredOption("--name <name>").option("--visibility <visibility>", "visibility", "public").action(async (options) => {
  const project = await loadProject(process.cwd());
  const parsed = entityFileSchema.parse({ ...options, state: {} });
  await writeJson(join(process.cwd(), SOCIETY_DIR, "entities.json"), project.entities.concat([parsed]));
  output(parsed, `Created entity ${parsed.id}`);
});
entity.command("update").argument("<id>").argument("<jsonPatch>").action(async (id, jsonPatch) => {
  const project = await loadProject(process.cwd());
  const patch = JSON.parse(jsonPatch) as Record<string, unknown>;
  const entities = project.entities.map((item) => (item.id === id ? { ...item, state: { ...item.state, ...patch } } : item));
  await writeJson(join(process.cwd(), SOCIETY_DIR, "entities.json"), entities);
  output(findById(entities, id));
});

const worldCommand = program.command("world").description("manage world");
worldCommand.command("show").action(async () => output((await loadProject(process.cwd())).world));
worldCommand.command("set").argument("<path>").argument("<jsonValue>").option("--dry-run", "preview without writing").action(async (path, jsonValue, options) => {
  const project = await loadProject(process.cwd());
  const next = setPath(project.world, path, JSON.parse(jsonValue));
  if (options.dryRun) {
    output({ before: project.world, after: next });
    return;
  }
  await writeJson(join(process.cwd(), SOCIETY_DIR, "world.json"), next);
  output(next, `Updated world.${path}`);
});
program.command("event").description("event helpers").command("inject").argument("<json>").action(async (json) => {
  const event = JSON.parse(json) as unknown;
  const path = join(process.cwd(), ".society", "logs", "injected-events.jsonl");
  await writeFile(path, `${JSON.stringify(event)}\n`, { flag: "a" });
  output({ injected: event, path });
});

const template = program.command("template").description("manage templates");
template.command("list").action(() => output(listTemplates().map((item) => ({ name: item.name, description: item.description }))));
template.command("show").argument("<name>").action((name) => output(getTemplate(name)));

program.parseAsync().catch((error) => {
  console.error(pc.red(errorMessage(error)));
  process.exitCode = 1;
});

function output(value: unknown, text?: string): void {
  if (program.opts().json) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  if (text) {
    console.log(text);
    return;
  }
  console.log(JSON.stringify(value, null, 2));
}

function parseIntOption(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) throw new Error(`Expected integer, got ${value}`);
  return parsed;
}

function findById<T extends { id: string }>(items: T[], id: string): T {
  const found = items.find((item) => item.id === id);
  if (!found) throw new Error(`Not found: ${id}`);
  return found;
}

function printTick(report: { tick: number; decisions: Array<{ agentId: string; decision: { thought: string; actions: Array<{ type: string }> } }>; events: Array<{ type: string; actorId?: string; targetId?: string }> }) {
  console.log(pc.bold(`Tick ${report.tick}`));
  for (const decision of report.decisions) {
    console.log(`${pc.cyan(decision.agentId)} ${decision.decision.thought}`);
    for (const action of decision.decision.actions) console.log(`  action: ${action.type}`);
  }
  for (const event of report.events) console.log(`  event: ${event.type} ${event.actorId ?? ""} -> ${event.targetId ?? "world"}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function setPath<T extends Record<string, unknown>>(object: T, path: string, value: unknown): T {
  const parts = path.split(".").filter(Boolean);
  if (parts.length === 0) throw new Error("Path cannot be empty");
  const copy = structuredClone(object) as Record<string, unknown>;
  let current = copy;
  for (const part of parts.slice(0, -1)) {
    const next = current[part];
    if (!next || typeof next !== "object" || Array.isArray(next)) current[part] = {};
    current = current[part] as Record<string, unknown>;
  }
  current[parts.at(-1)!] = value;
  return copy as T;
}
