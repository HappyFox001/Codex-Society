#!/usr/bin/env node
import { Command } from "commander";
import pc from "picocolors";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as outputStream } from "node:process";
import { mkdir, readFile, readdir, rm, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { select, input as promptInput, confirm, number as promptNumber } from "@inquirer/prompts";
import boxen from "boxen";
import Table from "cli-table3";
import ora, { type Ora } from "ora";
import {
  CodexCliBackend,
  CodexCliRuntime,
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
import type { AgentDecision, WorldEvent } from "../core/types.js";

const DEFAULT_TARGETS_DIR = "simulations";
const DEFAULT_RUNS_DIR = "runs";
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

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
  .option("-t, --template <name>", "template name")
  .option("--template-dir <path>", "directory containing template.json")
  .option("--dry-run", "show files without writing")
  .action(async (options) => {
    const root = process.cwd();
    const template = options.templateDir
      ? (await readJson(join(resolve(options.templateDir), "template.json")) as SocietyTemplate)
      : getTemplate(options.template ?? (process.stdin.isTTY ? await chooseTemplate() : "minimal"));
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
  .action(runSimulation);

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

program.command("shell").description("open interactive Society Shell").action(startShell);

class CliRunProgress {
  private readonly agents: Map<string, { name: string; role: string }>;
  private startedAt = 0;
  private spinner?: Ora;

  constructor(agents: Array<{ id: string; name: string; role: string }>) {
    this.agents = new Map(agents.map((agent) => [agent.id, { name: agent.name, role: agent.role }]));
  }

  runStart(event: { runId: string; backend: string; model: string; ticks: number; dir: string }): void {
    this.startedAt = Date.now();
    console.log(boxen([
      pc.bold("Run started"),
      "",
      `${pc.dim("id")}      ${event.runId}`,
      `${pc.dim("runtime")} ${event.backend} / ${event.model}`,
      `${pc.dim("ticks")}   ${event.ticks}`,
      `${pc.dim("output")}  ${event.dir}`,
    ].join("\n"), { padding: 1, borderColor: "cyan", borderStyle: "round" }));
  }

  tickStart(tick: number, total: number): void {
    console.log("");
    console.log(pc.bold(pc.cyan(`Tick ${tick}/${total}`)));
  }

  agentStart(event: { agentId: string }): void {
    const agent = this.agents.get(event.agentId);
    const label = agent ? `${agent.name} (${agent.role})` : event.agentId;
    this.spinner?.stop();
    this.spinner = ora({ text: `Agent turn: ${label}`, color: "cyan" }).start();
  }

  agentDecision(event: { decision: AgentDecision; events: WorldEvent[] }): void {
    const actionTypes = summarizeActionTypes(event.decision.actions.map((action) => action.type));
    const thought = truncate(event.decision.thought.replace(/\s+/g, " "), 140);
    this.spinner?.succeed(`Decision: ${thought}`);
    this.spinner = undefined;
    console.log(`  ${pc.dim("actions")} ${actionTypes || "none"}  ${pc.dim(`events ${event.events.length}`)}`);
    const changes = summarizeWorldEvents(event.events);
    if (changes.length) console.log(`  ${pc.dim("changes")} ${changes.join("; ")}`);
  }

  agentError(event: { agentId: string; error: unknown }): void {
    this.spinner?.fail(`Agent failed: ${event.agentId}`);
    this.spinner = undefined;
    console.log(`  ${pc.red("error")} ${truncate(errorMessage(event.error), 180)}`);
  }

  tickEnd(tick: number, eventCount: number): void {
    console.log(pc.green(`Tick ${tick} complete`) + pc.dim(` / events ${eventCount}`));
    console.log("");
  }

  runEnd(event: { runId: string; dir: string; interrupted: boolean }): void {
    this.spinner?.stop();
    this.spinner = undefined;
    const elapsed = ((Date.now() - this.startedAt) / 1000).toFixed(1);
    const status = event.interrupted ? pc.yellow("interrupted") : pc.green("completed");
    console.log(boxen([
      `${pc.bold("Run")} ${status}`,
      "",
      `${pc.dim("id")}        ${event.runId}`,
      `${pc.dim("duration")}  ${elapsed}s`,
      `${pc.dim("artifacts")} ${event.dir}`,
    ].join("\n"), { padding: 1, borderColor: event.interrupted ? "yellow" : "green", borderStyle: "round" }));
  }

  reportStart(): void {
    this.spinner = ora({ text: "Generating Chinese final report", color: "magenta" }).start();
  }

  runFailed(error: unknown): void {
    this.spinner?.fail("Run failed");
    this.spinner = undefined;
    const elapsed = this.startedAt ? ` ${pc.dim(`${((Date.now() - this.startedAt) / 1000).toFixed(1)}s`)}` : "";
    console.log(`${pc.bold("Run")} ${pc.red("failed")}${elapsed}`);
    console.log(pc.red(truncate(errorMessage(error), 500)));
  }
}

const argv = process.argv[2] === "--" ? process.argv.slice(0, 2).concat(process.argv.slice(3)) : process.argv;

if (argv.length <= 2) {
  await startShell();
  process.exit(0);
}

program.parseAsync(argv).catch((error) => {
  console.error(pc.red(errorMessage(error)));
  process.exitCode = 1;
});

async function runSimulation(options: {
  ticks?: number;
  scenario?: string;
  backend?: string;
  model?: string;
  gateway?: string;
  stream?: boolean;
  resume?: string;
  clearStaleLock?: boolean;
}): Promise<void> {
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
      : backend === "codex"
        ? new CodexCliRuntime({
          model,
          cwd: process.cwd(),
          sandbox: "danger-full-access",
          timeoutMs: project.config.codex.timeoutMs,
        })
        : new OpenAiCompatibleRuntime({ baseUrl: project.config.gateway ?? "http://127.0.0.1:8787", model });
  const world = toWorldState(project);
  const progress = backend === "codex" && !program.opts().json && (options.stream ?? true)
    ? new CliRunProgress(project.agents.map((agent) => ({ id: agent.id, name: agent.name, role: agent.role })))
    : undefined;
  const simulator = new SocietySimulator({
    world,
    runtime,
    continueOnAgentError: backend === "codex" ? false : project.config.continueOnAgentError,
    schedule: project.config.scheduler === "one-agent-per-tick" ? new OneAgentPerTickSchedule() : new RoundRobinSchedule(),
    onAgentStart: progress?.agentStart.bind(progress),
    onAgentDecision: progress?.agentDecision.bind(progress),
    onAgentError: progress?.agentError.bind(progress),
  });
  const runId = options.resume ?? createRunId();
  let lockPath: string | undefined;
  let interrupted = false;
  const manifest: RunManifest = { id: runId, status: "running", backend, model, ticksRequested: ticks, startedAt: new Date().toISOString() };
  lockPath = await acquireRunLock(process.cwd(), runId, Boolean(options.clearStaleLock));
  const dir = await startRun(process.cwd(), manifest);
  progress?.runStart({ runId, backend, model, ticks, dir });
  const onSigint = () => {
    interrupted = true;
  };
  process.once("SIGINT", onSigint);
  try {
    for (let i = 0; i < ticks; i += 1) {
      if (interrupted) break;
      progress?.tickStart(i + 1, ticks);
      const report = await simulator.runTick();
      const snapshot = simulator.snapshot();
      await writeTickArtifact(dir, report, snapshot);
      progress?.tickEnd(report.tick, report.events.length);
      if ((options.stream ?? true) && !progress) printTick(report);
    }
    await saveProjectWorld(process.cwd(), world);
    const snapshot = simulator.snapshot();
    await writeDerivedArtifacts(dir, snapshot);
    await finishRun(dir, { status: interrupted ? "interrupted" : "completed", endedAt: new Date().toISOString() });
    progress?.reportStart();
    await generateReport(dir, { ai: backend === "codex" && !interrupted, model, cwd: process.cwd() });
    progress?.runEnd({ runId, dir, interrupted });
    if (!progress) output({ runId, dir, interrupted }, `${interrupted ? "Interrupted" : "Completed"} ${pc.green(runId)} at ${dir}`);
  } catch (error) {
    await writeRunError(dir, error);
    await finishRun(dir, { status: "failed", endedAt: new Date().toISOString(), error: errorMessage(error) });
    progress?.runFailed(error);
    throw error;
  } finally {
    process.off("SIGINT", onSigint);
    await releaseRunLock(lockPath);
  }
}

async function startShell(): Promise<void> {
  if (!process.stdin.isTTY) {
    printBanner();
    const raw = await readStdin();
    for (const line of raw.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
      console.log(pc.cyan(`society> ${line}`));
      if (["/exit", "exit", "quit", "/quit"].includes(line)) break;
      try {
        await handleShellLine(line);
      } catch (error) {
        console.log(pc.red(errorMessage(error)));
      }
    }
    return;
  }
  await renderWorkbenchHome();
  for (;;) {
    const action = await chooseMainAction();
    if (action === "exit") break;
    try {
      if (action === "simulate") {
        const target = await chooseSimulationTarget();
        const ticks = await chooseTicks(undefined, target);
        if (await confirmRunPlan(target, ticks)) await simulateTarget(target, ticks);
      } else if (action === "create") {
        await createSimulationTarget();
      } else if (action === "targets") {
        await printSimulationTargets();
      } else if (action === "runs") {
        await printRecentRuns();
      } else if (action.startsWith("/")) {
        await handleShellLine(action);
      }
    } catch (error) {
      console.log(pc.red(errorMessage(error)));
    }
  }
}

type MainAction = "simulate" | "create" | "targets" | "runs" | "exit" | `/${string}`;

async function chooseMainAction(rl?: ReturnType<typeof createInterface>): Promise<MainAction> {
  if (process.stdin.isTTY && !rl) {
    return select<MainAction>({
      message: "What do you want to do?",
      choices: [
        { name: "Run a simulation", value: "simulate", description: "Choose a target and start a Codex-backed run" },
        { name: "Create a simulation target", value: "create", description: "Create a template under simulations/" },
        { name: "Browse targets", value: "targets", description: "Show configured targets" },
        { name: "Browse recent runs", value: "runs", description: "Show saved runs under runs/" },
        { name: "Exit", value: "exit" },
      ],
    });
  }
  console.log("");
  console.log(pc.bold("Choose action"));
  console.log(`  ${pc.cyan("1")}  Simulate target`);
  console.log(`  ${pc.cyan("2")}  Create target template`);
  console.log(`  ${pc.cyan("3")}  List targets`);
  console.log(`  ${pc.cyan("4")}  Exit`);
  const answer = (await rl!.question("Select [1]: ")).trim();
  if (!answer || answer === "1" || /^simulate$/i.test(answer)) return "simulate";
  if (answer === "2" || /^create$/i.test(answer)) return "create";
  if (answer === "3" || /^targets?$/i.test(answer)) return "targets";
  if (answer === "4" || /^exit|quit$/i.test(answer)) return "exit";
  if (answer.startsWith("/")) return answer as MainAction;
  throw new Error(`Unknown action: ${answer}`);
}

function readStdin(): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    let raw = "";
    input.setEncoding("utf8");
    input.on("data", (chunk) => {
      raw += chunk;
    });
    input.on("end", () => resolvePromise(raw));
    input.on("error", rejectPromise);
  });
}

async function handleShellLine(inputLine: string): Promise<void> {
  const line = normalizeShellLine(inputLine);
  const [command, ...args] = splitArgs(line);
  switch (command) {
    case "/help":
    case "help":
      printShellHelp();
      return;
    case "/targets":
    case "targets": {
      await printSimulationTargets();
      return;
    }
    case "/simulate":
    case "simulate": {
      const target = args[0] ?? await chooseSimulationTarget();
      const ticks = Number(args[1] ?? await defaultTicksForTarget(target));
      await simulateTarget(target, ticks);
      return;
    }
    case "/create":
    case "create": {
      await createSimulationTarget(args[0]);
      return;
    }
    case "/init":
    case "init": {
      const templateDirIndex = args.indexOf("--template-dir");
      const template = templateDirIndex >= 0
        ? (await readJson(join(resolve(args[templateDirIndex + 1] ?? ""), "template.json")) as SocietyTemplate)
        : getTemplate(args[0] ?? await chooseTemplate());
      const files = await initProject(process.cwd(), template);
      console.log(`Created ${pc.green(template.name)} society project (${files.length} files).`);
      return;
    }
    case "/templates":
    case "templates":
      console.table(listTemplates().map((item) => ({ name: item.name, description: item.description })));
      return;
    case "/doctor":
    case "doctor":
      await runDoctorForShell();
      return;
    case "/run":
    case "run":
      await runSimulation({ ticks: Number(args[0] ?? 5), backend: "static", stream: true });
      return;
    case "/run-codex":
      await runSimulation({ ticks: Number(args[0] ?? 5), gateway: args[1] ?? "http://127.0.0.1:8787", model: args[2] ?? "gpt-5", stream: true });
      return;
    case "/agents":
    case "agents":
      console.table((await loadProject(process.cwd())).agents.map((agent) => ({ id: agent.id, name: agent.name, role: agent.role, goal: agent.goal })));
      return;
    case "/relations":
    case "relations":
      console.table((await loadProject(process.cwd())).relations);
      return;
    case "/observe":
    case "observe": {
      const agentId = args[0];
      if (!agentId) throw new Error("Usage: /observe <agent-id>");
      const project = await loadProject(process.cwd());
      const observation = new DefaultObservationProjector().project(toWorldState(project).snapshot(), agentId);
      console.log(JSON.stringify(observation, null, 2));
      return;
    }
    case "/status":
    case "status": {
      const id = await latestRunId(process.cwd());
      if (!id) throw new Error("No run found.");
      console.log(JSON.stringify(await readJson(join(runDir(process.cwd(), id), "run.json")), null, 2));
      return;
    }
    case "/report":
    case "report": {
      const id = args[0] ?? await latestRunId(process.cwd());
      if (!id) throw new Error("No run found.");
      console.log(await generateReport(runDir(process.cwd(), id)));
      return;
    }
    case "/serve-codex":
      console.log("Run this in a second terminal: pnpm run cli -- serve --backend codex --port 8787");
      return;
    default:
      throw new Error(`Unknown command: ${command}. Try /help.`);
  }
}

function normalizeShellLine(line: string): string {
  if (line.startsWith("/")) return line;
  const lower = line.toLowerCase();
  if (lower.includes("创建")) return "/create";
  if (lower.includes("模拟") || lower.includes("运行") || lower.includes("run")) return "/simulate";
  return line;
}

function splitArgs(line: string): string[] {
  return line.match(/"[^"]+"|'[^']+'|\S+/g)?.map((part) => part.replace(/^["']|["']$/g, "")) ?? [];
}

function printBanner(): void {
  console.log(pc.bold("Codex Society"));
  console.log("Simulation target workbench");
  console.log("Use the menu to run an existing target or create a new target template.");
}

async function renderWorkbenchHome(): Promise<void> {
  const targets = await listSimulationTargets();
  const latest = await latestSavedRun();
  console.log(boxen([
    pc.bold("Codex Society"),
    pc.dim("Multi-agent simulation workbench"),
    "",
    `${pc.dim("Runtime")}  Codex full-access`,
    `${pc.dim("Targets")}  ${targets.length} available`,
    `${pc.dim("Runs")}     ${defaultRunsDir()}`,
    `${pc.dim("Latest")}   ${latest ? `${latest.targetId} / ${latest.runId}` : "none"}`,
  ].join("\n"), { padding: 1, margin: 0, borderColor: "cyan", borderStyle: "round" }));
}

function printShellHelp(): void {
  console.log([
    "Menu actions:",
    "  Simulate target          choose and run a target from simulations/",
    "  Create target template   create a new target under simulations/",
    "  List targets             show available simulation targets",
    "",
    "Automation commands still exist: /simulate, /create, /targets, init, run, report, observe, serve.",
  ].join("\n"));
}

interface SimulationTargetSummary {
  id: string;
  description: string;
  agents: number;
  defaultTicks: number;
  backend: string;
  model: string;
  latestRun?: string;
  coreQuestion?: string;
}

async function listSimulationTargets(): Promise<SimulationTargetSummary[]> {
  try {
    const names = (await readdir(defaultTargetsDir(), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    const targets = [];
    for (const id of names) {
      const template = await readJson(join(defaultTargetsDir(), id, "template.json")) as SocietyTemplate;
      targets.push({
        id,
        description: template.description,
        agents: template.agents.length,
        defaultTicks: template.scenarios[0]?.ticks ?? 6,
        backend: template.config.backend,
        model: template.config.model,
        latestRun: await latestRunForTarget(id),
        coreQuestion: typeof template.world.state.planningQuestion === "string" ? template.world.state.planningQuestion : undefined,
      });
    }
    return targets;
  } catch {
    return [];
  }
}

async function printSimulationTargets(): Promise<void> {
  const targets = await listSimulationTargets();
  if (targets.length === 0) {
    console.log(`No simulation targets found in ${defaultTargetsDir()}.`);
    return;
  }
  const table = new Table({
    head: ["Target", "Agents", "Ticks", "Runtime", "Latest run", "Description"],
    style: { head: ["cyan"] },
    wordWrap: true,
    colWidths: [24, 8, 8, 18, 24, 58],
  });
  for (const target of targets) {
    table.push([target.id, target.agents, target.defaultTicks, `${target.backend}/${target.model}`, target.latestRun ?? "-", target.description]);
  }
  console.log(table.toString());
}

async function chooseSimulationTarget(rl?: ReturnType<typeof createInterface>): Promise<string> {
  const targets = await listSimulationTargets();
  if (targets.length === 0) {
    throw new Error(`No simulation targets found in ${defaultTargetsDir()}. Create a target first.`);
  }
  if (!process.stdin.isTTY) {
    return targets[0].id;
  }
  if (!rl) {
    const targetId = await select<string>({
      message: "Choose a simulation target",
      choices: targets.map((target) => ({
        name: `${target.id}  ${pc.dim(`${target.agents} agents / ${target.defaultTicks} ticks`)}`,
        value: target.id,
        description: target.coreQuestion ?? target.description,
      })),
    });
    await printTargetBrief(targetId);
    return targetId;
  }
  console.log("");
  console.log(pc.bold("Executable targets"));
  targets.forEach((target, index) => {
    console.log(`  ${pc.cyan(String(index + 1))}  ${target.id} - ${target.description}`);
  });
  if (rl) return readTargetChoice(rl, targets);
  const local = createInterface({ input, output: outputStream });
  try {
    return await readTargetChoice(local, targets);
  } finally {
    local.close();
  }
}

async function readTargetChoice(rl: ReturnType<typeof createInterface>, targets: Array<{ id: string; description: string }>): Promise<string> {
  const answer = (await rl.question(`Select target [1]: `)).trim();
  if (!answer) return targets[0].id;
  const selected = Number.parseInt(answer, 10);
  if (Number.isInteger(selected) && selected >= 1 && selected <= targets.length) return targets[selected - 1].id;
  if (targets.some((target) => target.id === answer)) return answer;
  throw new Error(`Unknown target: ${answer}`);
}

async function chooseTicks(rl: ReturnType<typeof createInterface> | undefined, targetId: string): Promise<number> {
  const fallback = await defaultTicksForTarget(targetId);
  if (process.stdin.isTTY && !rl) {
    const answer = await promptNumber({
      message: "Ticks",
      default: fallback,
      min: 1,
      required: true,
    });
    return Number(answer ?? fallback);
  }
  const answer = (await rl!.question(`Ticks [${fallback}]: `)).trim();
  if (!answer) return fallback;
  const ticks = Number.parseInt(answer, 10);
  if (!Number.isFinite(ticks) || ticks <= 0) throw new Error("Ticks must be a positive integer.");
  return ticks;
}

async function defaultTicksForTarget(targetId: string): Promise<number> {
  const template = await readJson(join(resolve(defaultTargetsDir(), targetId), "template.json")) as SocietyTemplate;
  return template.scenarios[0]?.ticks ?? 6;
}

async function printTargetBrief(targetId: string): Promise<void> {
  const template = await readJson(join(resolve(defaultTargetsDir(), targetId), "template.json")) as SocietyTemplate;
  const latest = await latestRunForTarget(targetId);
  const agents = template.agents.map((agent) => `${agent.name} (${agent.role})`).join("\n");
  console.log(boxen([
    pc.bold(template.name),
    "",
    template.world.state.planningQuestion ? `${pc.dim("question")} ${String(template.world.state.planningQuestion)}` : template.description,
    "",
    `${pc.dim("agents")}   ${template.agents.length}`,
    `${pc.dim("ticks")}    ${template.scenarios[0]?.ticks ?? 6}`,
    `${pc.dim("runtime")}  ${template.config.backend} / ${template.config.model}`,
    `${pc.dim("latest")}   ${latest ?? "none"}`,
    "",
    pc.dim("Agent roster"),
    agents,
  ].join("\n"), { padding: 1, borderColor: "cyan", borderStyle: "round" }));
}

async function confirmRunPlan(targetId: string, ticks: number): Promise<boolean> {
  const template = await readJson(join(resolve(defaultTargetsDir(), targetId), "template.json")) as SocietyTemplate;
  const runRoot = join(defaultRunsDir(), targetId);
  console.log(boxen([
    pc.bold("Run plan"),
    "",
    `${pc.dim("target")}  ${targetId}`,
    `${pc.dim("question")} ${String(template.world.state.planningQuestion ?? template.description)}`,
    `${pc.dim("agents")}  ${template.agents.length}`,
    `${pc.dim("ticks")}   ${ticks}`,
    `${pc.dim("runtime")} Codex full-access / ${template.config.model}`,
    `${pc.dim("output")}  ${runRoot}`,
  ].join("\n"), { padding: 1, borderColor: "yellow", borderStyle: "round" }));
  return confirm({ message: "Start simulation?", default: true });
}

async function printRunComplete(destination: string): Promise<void> {
  const manifest = await readJson(join(destination, "run.json")) as RunManifest;
  const metrics = await readJson(join(destination, "metrics.json")) as { tick: number; eventCount: number; agentCount: number; relationCount: number };
  console.log(boxen([
    pc.bold("Simulation saved"),
    "",
    `${pc.dim("run")}      ${manifest.id}`,
    `${pc.dim("ticks")}    ${metrics.tick}`,
    `${pc.dim("agents")}   ${metrics.agentCount}`,
    `${pc.dim("events")}   ${metrics.eventCount}`,
    `${pc.dim("report")}   ${join(destination, "REPORT.md")}`,
  ].join("\n"), { padding: 1, borderColor: "green", borderStyle: "round" }));
  const preview = process.stdin.isTTY
    ? await select<"summary" | "full" | "skip">({
      message: "Report preview",
      choices: [
        { name: "Show summary", value: "summary" },
        { name: "Show full report", value: "full" },
        { name: "Skip", value: "skip" },
      ],
    })
    : "full";
  if (preview === "skip") return;
  const report = await readFile(join(destination, "REPORT.md"), "utf8");
  console.log(preview === "summary" ? firstReportSections(report, 2) : report);
}

function firstReportSections(report: string, count: number): string {
  const lines = report.split(/\r?\n/);
  const indexes = lines.map((line, index) => line.startsWith("# ") || line.startsWith("## ") ? index : -1).filter((index) => index >= 0);
  const end = indexes[count] ?? Math.min(lines.length, 80);
  return lines.slice(0, end).join("\n");
}

async function simulateTarget(targetId: string, ticks: number): Promise<void> {
  const targetDir = resolve(defaultTargetsDir(), targetId);
  const template = await readJson(join(targetDir, "template.json")) as SocietyTemplate;
  const runRoot = resolve(defaultRunsDir(), targetId);
  const workspace = join(runRoot, "_workspace");
  await rm(workspace, { recursive: true, force: true });
  await mkdir(workspace, { recursive: true });
  await initProject(workspace, template);
  const previous = process.cwd();
  process.chdir(workspace);
  try {
    console.log(boxen([
      pc.bold(`Running ${template.name}`),
      "",
      `${pc.dim("runtime")} Codex full-access`,
      `${pc.dim("ticks")}   ${ticks}`,
      `${pc.dim("workspace")} ${workspace}`,
      `${pc.dim("output")}  ${runRoot}`,
    ].join("\n"), { padding: 1, borderColor: "blue", borderStyle: "round" }));
    await runDoctorForShell();
    console.log("");
    await runSimulation({ ticks, backend: "codex", model: template.config.model, stream: true });
    console.log("");
    const id = await latestRunId(process.cwd());
    if (id) {
      const source = runDir(process.cwd(), id);
      const destination = join(runRoot, id);
      await rm(destination, { recursive: true, force: true });
      await rename(source, destination);
      await printRunComplete(destination);
    }
  } finally {
    process.chdir(previous);
    await rm(workspace, { recursive: true, force: true });
  }
}

async function createSimulationTarget(idFromArgs?: string, rl?: ReturnType<typeof createInterface>): Promise<void> {
  const id = idFromArgs ?? await promptText("Target id", undefined, rl);
  if (!id || !/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    throw new Error("Target id must use lowercase letters, numbers, and dashes.");
  }
  const title = await promptText("Title", id, rl);
  const description = await promptText("Description", `Simulation target: ${title}`, rl);
  const base = getTemplate("minimal");
  const target: SocietyTemplate = {
    ...base,
    name: id as never,
    description,
    config: { ...base.config, name: id, description },
    world: {
      ...base.world,
      publicFacts: [`Target: ${title}`, "Edit this target's template.json to add researched facts, agents and scenario details."],
      state: { topic: title },
    },
  };
  const dir = resolve(defaultTargetsDir(), id);
  await mkdir(dir, { recursive: true });
  await writeJson(join(dir, "template.json"), target);
  await writeFile(join(dir, "README.md"), `# ${title}\n\n${description}\n\nRun with:\n\n\`\`\`text\n/simulate ${id}\n\`\`\`\n`, "utf8");
  console.log(boxen([
    pc.bold("Target created"),
    "",
    `${pc.dim("id")}   ${id}`,
    `${pc.dim("path")} ${dir}`,
    `${pc.dim("next")} Edit template.json, then run it from the workbench`,
  ].join("\n"), { padding: 1, borderColor: "green", borderStyle: "round" }));
}

async function promptText(label: string, fallback?: string, rl?: ReturnType<typeof createInterface>): Promise<string> {
  if (!process.stdin.isTTY) return fallback ?? "";
  if (!rl) {
    return promptInput({ message: label, default: fallback });
  }
  if (rl) {
    const suffix = fallback ? ` [${fallback}]` : "";
    const answer = (await rl.question(`${label}${suffix}: `)).trim();
    return answer || fallback || "";
  }
  const local = createInterface({ input, output: outputStream });
  try {
    const suffix = fallback ? ` [${fallback}]` : "";
    const answer = (await local.question(`${label}${suffix}: `)).trim();
    return answer || fallback || "";
  } finally {
    local.close();
  }
}

function defaultTargetsDir(): string {
  return process.env.CODEX_SOCIETY_TARGETS_DIR
    ? resolve(process.env.CODEX_SOCIETY_TARGETS_DIR)
    : resolve(PACKAGE_ROOT, DEFAULT_TARGETS_DIR);
}

function defaultRunsDir(): string {
  return process.env.CODEX_SOCIETY_RUNS_DIR
    ? resolve(process.env.CODEX_SOCIETY_RUNS_DIR)
    : resolve(PACKAGE_ROOT, DEFAULT_RUNS_DIR);
}

async function latestRunForTarget(targetId: string): Promise<string | undefined> {
  try {
    return (await readdir(join(defaultRunsDir(), targetId), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("run_"))
      .map((entry) => entry.name)
      .sort()
      .at(-1);
  } catch {
    return undefined;
  }
}

async function latestSavedRun(): Promise<{ targetId: string; runId: string } | undefined> {
  try {
    const targets = (await readdir(defaultRunsDir(), { withFileTypes: true })).filter((entry) => entry.isDirectory());
    const runs = await Promise.all(targets.map(async (target) => {
      const runId = await latestRunForTarget(target.name);
      return runId ? { targetId: target.name, runId } : undefined;
    }));
    return runs.filter((run): run is { targetId: string; runId: string } => Boolean(run)).sort((a, b) => a.runId.localeCompare(b.runId)).at(-1);
  } catch {
    return undefined;
  }
}

async function printRecentRuns(): Promise<void> {
  const rows: Array<[string, string, string, string, string]> = [];
  try {
    const targetEntries = (await readdir(defaultRunsDir(), { withFileTypes: true })).filter((entry) => entry.isDirectory());
    for (const target of targetEntries) {
      const runEntries = (await readdir(join(defaultRunsDir(), target.name), { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && entry.name.startsWith("run_"))
        .map((entry) => entry.name)
        .sort()
        .slice(-5);
      for (const runId of runEntries) {
        const dir = join(defaultRunsDir(), target.name, runId);
        const manifest = await readJson(join(dir, "run.json")) as RunManifest;
        const metrics = await readJson(join(dir, "metrics.json")).catch(() => undefined) as { tick?: number; eventCount?: number } | undefined;
        rows.push([target.name, runId, manifest.status, String(metrics?.tick ?? "-"), String(metrics?.eventCount ?? "-")]);
      }
    }
  } catch {
    // No runs yet.
  }
  if (rows.length === 0) {
    console.log(pc.dim("No saved runs yet."));
    return;
  }
  const table = new Table({ head: ["Target", "Run", "Status", "Ticks", "Events"], style: { head: ["cyan"] } });
  for (const row of rows.sort((a, b) => b[1].localeCompare(a[1])).slice(0, 12)) table.push(row);
  console.log(table.toString());
}

async function chooseTemplate(): Promise<string> {
  if (!process.stdin.isTTY) return "minimal";
  const rl = createInterface({ input, output: outputStream });
  try {
    console.log("Choose a template:");
    for (const item of listTemplates()) console.log(`  ${item.name.padEnd(8)} ${item.description}`);
    const answer = (await rl.question("template [campus]: ")).trim();
    return answer || "campus";
  } finally {
    rl.close();
  }
}

async function runDoctorForShell(): Promise<void> {
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
  console.log(checks.map((check) => `${check.ok ? pc.green("OK") : pc.red("FAIL")} ${check.name}${check.detail ? ` ${check.detail}` : ""}`).join("\n"));
}

function summarizeActionTypes(types: string[]): string {
  const counts = new Map<string, number>();
  for (const type of types) counts.set(type, (counts.get(type) ?? 0) + 1);
  return [...counts.entries()].map(([type, count]) => (count === 1 ? type : `${type}x${count}`)).join(", ");
}

function summarizeWorldEvents(events: WorldEvent[]): string[] {
  const summaries: string[] = [];
  for (const event of events.slice(0, 4)) {
    if (event.type === "message") {
      const scope = event.targetId ? `to ${event.targetId}` : event.visibility;
      summaries.push(`message ${scope}`);
    } else if (event.type === "entity.updated") {
      summaries.push(`entity ${event.targetId ?? event.payload.entityId ?? "updated"}`);
    } else if (event.type === "relation.updated") {
      summaries.push(`relation ${event.actorId ?? "agent"} -> ${event.targetId ?? "target"}`);
    } else if (event.type === "memory.remembered") {
      summaries.push(`memory ${event.actorId ?? "agent"}`);
    } else {
      summaries.push(event.type);
    }
  }
  if (events.length > 4) summaries.push(`+${events.length - 4} more`);
  return summaries;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}...`;
}

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
