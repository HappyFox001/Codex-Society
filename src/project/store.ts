import { mkdir, readFile, readdir, writeFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentMemory, AgentProfile, Relation, WorldEntity } from "../core/types.js";
import { WorldState } from "../core/world.js";
import {
  agentFileSchema,
  entityFileSchema,
  goalFileSchema,
  relationFileSchema,
  scenarioFileSchema,
  societyConfigSchema,
  worldFileSchema,
  type AgentFile,
  type SocietyProject,
} from "./schemas.js";
import type { SocietyTemplate } from "./templates.js";

export const SOCIETY_DIR = "society";
export const META_DIR = ".society";

export async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function initProject(root: string, template: SocietyTemplate, options: { dryRun?: boolean } = {}) {
  const files = projectFiles(root, template);
  if (options.dryRun) {
    return files.map((file) => file.path);
  }
  for (const file of files) {
    await writeJson(file.path, file.value);
  }
  await mkdir(join(root, META_DIR, "runs"), { recursive: true });
  await mkdir(join(root, META_DIR, "logs"), { recursive: true });
  await mkdir(join(root, META_DIR, "status"), { recursive: true });
  await writeFile(join(root, "SOCIETY_GUIDE.md"), societyGuide(template), "utf8");
  return files.map((file) => file.path).concat([join(root, "SOCIETY_GUIDE.md")]);
}

export async function loadProject(root: string): Promise<SocietyProject> {
  const config = societyConfigSchema.parse(await readJson(join(root, META_DIR, "config.json")));
  const world = worldFileSchema.parse(await readJson(join(root, SOCIETY_DIR, "world.json")));
  const agents = await readJsonArrayFiles(join(root, SOCIETY_DIR, "agents"), agentFileSchema.parse);
  const relations = zArray(await readJson(join(root, SOCIETY_DIR, "relations.json")), relationFileSchema.parse);
  const entities = zArray(await readJson(join(root, SOCIETY_DIR, "entities.json")), entityFileSchema.parse);
  const goals = zArray(await readJson(join(root, SOCIETY_DIR, "goals.json")), goalFileSchema.parse);
  const scenarios = await readJsonArrayFiles(join(root, SOCIETY_DIR, "scenarios"), scenarioFileSchema.parse);
  return { root, config, world, agents, relations, entities, goals, scenarios };
}

export function toWorldState(project: SocietyProject): WorldState {
  const agents: AgentProfile[] = project.agents.map(({ memory: _memory, ...agent }) => agent);
  const memory: Record<string, AgentMemory> = Object.fromEntries(project.agents.map((agent) => [agent.id, agent.memory]));
  return new WorldState({
    tick: project.world.tick,
    agents,
    memory,
    relations: project.relations as Relation[],
    entities: project.entities as WorldEntity[],
  });
}

export async function saveProjectWorld(root: string, world: WorldState): Promise<void> {
  const snapshot = world.snapshot();
  const currentWorld = worldFileSchema.parse(await readJson(join(root, SOCIETY_DIR, "world.json")));
  await writeJson(join(root, SOCIETY_DIR, "world.json"), { ...currentWorld, tick: snapshot.tick });
  await writeJson(join(root, SOCIETY_DIR, "relations.json"), snapshot.relations);
  await writeJson(join(root, SOCIETY_DIR, "entities.json"), snapshot.entities);
  for (const agent of snapshot.agents) {
    const current = agentFileSchema.parse(await readJson(join(root, SOCIETY_DIR, "agents", `${agent.id}.json`)));
    await writeJson(join(root, SOCIETY_DIR, "agents", `${agent.id}.json`), {
      ...current,
      memory: snapshot.memory[agent.id] ?? current.memory,
    } satisfies AgentFile);
  }
}

function projectFiles(root: string, template: SocietyTemplate) {
  return [
    { path: join(root, META_DIR, "manifest.json"), value: { version: 1, template: template.name, createdAt: new Date().toISOString() } },
    { path: join(root, META_DIR, "config.json"), value: template.config },
    { path: join(root, SOCIETY_DIR, "world.json"), value: template.world },
    { path: join(root, SOCIETY_DIR, "relations.json"), value: template.relations },
    { path: join(root, SOCIETY_DIR, "entities.json"), value: template.entities },
    { path: join(root, SOCIETY_DIR, "goals.json"), value: template.goals },
    { path: join(root, SOCIETY_DIR, "tools.json"), value: { tools: ["say", "remember", "updateRelation", "updateEntity", "noop"] } },
    ...template.agents.map((agent) => ({ path: join(root, SOCIETY_DIR, "agents", `${agent.id}.json`), value: agent })),
    ...template.scenarios.map((scenario) => ({ path: join(root, SOCIETY_DIR, "scenarios", `${scenario.name}.json`), value: scenario })),
  ];
}

async function readJsonArrayFiles<T>(dir: string, parse: (input: unknown) => T): Promise<T[]> {
  const names = (await readdir(dir)).filter((name) => name.endsWith(".json")).sort();
  return Promise.all(names.map(async (name) => parse(await readJson(join(dir, name)))));
}

function zArray<T>(value: unknown, parse: (input: unknown) => T): T[] {
  if (!Array.isArray(value)) {
    throw new Error("Expected JSON array");
  }
  return value.map(parse);
}

function societyGuide(template: SocietyTemplate): string {
  return [
    "# Society Guide",
    "",
    `Project: ${template.name}`,
    "",
    template.description,
    "",
    "## Commands",
    "",
    "- `codex-society doctor`",
    "- `codex-society run --ticks 5 --save`",
    "- `codex-society report <run-id>`",
    "",
    "## Artifact Contract",
    "",
    "- Config: `.society/config.json`",
    "- Agents: `society/agents/*.json`",
    "- Relations: `society/relations.json`",
    "- Runs: `.society/runs/<run-id>/`",
    "",
  ].join("\n");
}
