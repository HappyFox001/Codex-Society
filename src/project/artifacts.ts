import { appendFile, mkdir, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SimulationReport, WorldStateSnapshot } from "../core/types.js";
import { META_DIR, writeJson } from "./store.js";

export interface RunManifest {
  id: string;
  status: "running" | "completed" | "interrupted" | "failed";
  backend: string;
  model: string;
  ticksRequested: number;
  startedAt: string;
  endedAt?: string;
  error?: string;
}

export function createRunId(date = new Date()): string {
  const stamp = date.toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "_");
  return `run_${stamp}`;
}

export function runDir(root: string, runId: string): string {
  return join(root, META_DIR, "runs", runId);
}

export async function startRun(root: string, manifest: RunManifest): Promise<string> {
  const dir = runDir(root, manifest.id);
  await mkdir(join(dir, "ticks"), { recursive: true });
  await mkdir(join(dir, "decisions"), { recursive: true });
  await mkdir(join(dir, "snapshots"), { recursive: true });
  await writeJson(join(dir, "run.json"), manifest);
  return dir;
}

export async function acquireRunLock(root: string, runId: string, clearStale = false): Promise<string> {
  const dir = runDir(root, runId);
  await mkdir(dir, { recursive: true });
  const lockPath = join(dir, "run.lock");
  if (clearStale) {
    await rm(lockPath, { force: true });
  }
  const handle = await open(lockPath, "wx");
  await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
  await handle.close();
  return lockPath;
}

export async function releaseRunLock(lockPath: string | undefined): Promise<void> {
  if (lockPath) {
    await rm(lockPath, { force: true });
  }
}

export async function writeTickArtifact(dir: string, report: SimulationReport, snapshot: WorldStateSnapshot): Promise<void> {
  await writeJson(join(dir, "ticks", `${report.tick}.json`), report);
  await mkdir(join(dir, "decisions", `${report.tick}`), { recursive: true });
  for (const decision of report.decisions) {
    await writeJson(join(dir, "decisions", `${report.tick}`, `${decision.agentId}.json`), decision);
  }
  await writeJson(join(dir, "snapshots", `${report.tick}.json`), snapshot);
  for (const event of report.events) {
    await appendFile(join(dir, "events.jsonl"), `${JSON.stringify(event)}\n`, "utf8");
  }
}

export async function writeRunError(dir: string, error: unknown, context: Record<string, unknown> = {}): Promise<void> {
  await appendFile(
    join(dir, "errors.jsonl"),
    `${JSON.stringify({ ts: new Date().toISOString(), message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined, ...context })}\n`,
    "utf8",
  );
}

export async function finishRun(dir: string, patch: Pick<RunManifest, "status" | "endedAt" | "error">): Promise<void> {
  const manifest = JSON.parse(await readFile(join(dir, "run.json"), "utf8")) as RunManifest;
  await writeJson(join(dir, "run.json"), { ...manifest, ...patch });
}

export async function latestRunId(root: string): Promise<string | undefined> {
  const dir = join(root, META_DIR, "runs");
  try {
    return (await readdir(dir)).filter((name) => name.startsWith("run_")).sort().at(-1);
  } catch {
    return undefined;
  }
}

export async function writeDerivedArtifacts(dir: string, snapshot: WorldStateSnapshot): Promise<void> {
  await writeJson(join(dir, "metrics.json"), {
    tick: snapshot.tick,
    eventCount: snapshot.events.length,
    agentCount: snapshot.agents.length,
    relationCount: snapshot.relations.length,
  });
  await writeJson(
    join(dir, "timeline.json"),
    snapshot.events.map((event) => ({ tick: event.tick, type: event.type, actorId: event.actorId, targetId: event.targetId })),
  );
  await writeJson(join(dir, "graph.json"), {
    nodes: snapshot.agents.map((agent) => ({ id: agent.id, label: agent.name, role: agent.role })),
    edges: snapshot.relations.map((relation) => ({
      source: relation.from,
      target: relation.to,
      kind: relation.kind,
      trust: relation.trust,
      affinity: relation.affinity,
    })),
  });
}
