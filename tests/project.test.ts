import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getTemplate, initProject, loadProject, startRun, writeDerivedArtifacts, writeTickArtifact } from "../src/index.js";

test("schema and project loader parse generated template", async () => {
  const root = await mkdtemp(join(tmpdir(), "society-project-"));
  await initProject(root, getTemplate("campus"));
  const project = await loadProject(root);
  assert.equal(project.config.name, "campus");
  assert.equal(project.agents.length, 3);
  assert.equal(project.entities.length, 2);
});

test("run artifacts can be written", async () => {
  const root = await mkdtemp(join(tmpdir(), "society-artifacts-"));
  const dir = await startRun(root, {
    id: "run_test",
    status: "running",
    backend: "static",
    model: "society-static",
    ticksRequested: 1,
    startedAt: new Date(0).toISOString(),
  });
  const snapshot = { tick: 1, agents: [], entities: [], relations: [], events: [], memory: {} };
  await writeTickArtifact(dir, { tick: 1, decisions: [], events: [] }, snapshot);
  await writeDerivedArtifacts(dir, snapshot);
  assert.ok(dir.endsWith("run_test"));
});
