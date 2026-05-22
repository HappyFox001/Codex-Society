import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CodexCliBackend } from "../api/backends.js";
import type { ChatBackend } from "../api/types.js";
import type { RunManifest } from "./artifacts.js";

export interface GenerateReportOptions {
  ai?: boolean;
  model?: string;
  cwd?: string;
  backend?: ChatBackend;
}

export async function generateReport(runDirectory: string, options: GenerateReportOptions = {}): Promise<string> {
  const manifest = JSON.parse(await readFile(join(runDirectory, "run.json"), "utf8")) as RunManifest;
  const metrics = JSON.parse(await readFile(join(runDirectory, "metrics.json"), "utf8")) as {
    tick: number;
    eventCount: number;
    agentCount: number;
    relationCount: number;
  };
  const basicReport = basicRunReport(manifest, metrics);
  const report = options.ai
    ? await generateAiReport(runDirectory, basicReport, options).catch((error: unknown) => `${basicReport}

## AI Report

AI report generation failed: ${error instanceof Error ? error.message : String(error)}
`)
    : basicReport;
  await writeFile(join(runDirectory, "REPORT.md"), report, "utf8");
  return report;
}

function basicRunReport(manifest: RunManifest, metrics: { tick: number; eventCount: number; agentCount: number; relationCount: number }): string {
  return `# Society Run Report

Run: \`${manifest.id}\`

Status: \`${manifest.status}\`

Backend: \`${manifest.backend}\`

Model: \`${manifest.model}\`

## Summary

- Ticks completed: ${metrics.tick}
- Agents: ${metrics.agentCount}
- Relations: ${metrics.relationCount}
- Events: ${metrics.eventCount}
- Started: ${manifest.startedAt}
- Ended: ${manifest.endedAt ?? "n/a"}

## Artifacts

- \`run.json\`
- \`events.jsonl\`
- \`timeline.json\`
- \`graph.json\`
- \`metrics.json\`
`;
}

async function generateAiReport(runDirectory: string, basicReport: string, options: GenerateReportOptions): Promise<string> {
  const backend = options.backend ?? new CodexCliBackend({ defaultCwd: options.cwd, timeoutMs: 180_000 });
  const digest = await buildReportDigest(runDirectory);
  const raw = await backend.complete({
    model: options.model ?? "codex-default",
    cwd: options.cwd,
    sandbox: "danger-full-access",
    timeoutMs: 180_000,
    prompt: [
      "You are generating the final report for a Codex Society simulation.",
      "Write the final report in Simplified Chinese.",
      "The intermediate agent decisions, events, ids, action types and artifact names may remain in English when quoting evidence.",
      "Write a detailed Markdown report that answers the simulation's core objective, not a generic run log.",
      "Use the provided artifacts as evidence. Do not invent facts outside the artifacts.",
      "",
      "The report must include these Chinese sections:",
      "1. 执行结论",
      "2. 核心目标",
      "3. 最终建议",
      "4. 关键发现",
      "5. 各 Agent 贡献",
      "6. 互动与影响路径",
      "7. 有意义的数据",
      "8. 事件证据",
      "9. 剩余不确定性",
      "10. 产物索引",
      "",
      "Requirements:",
      "- Use Simplified Chinese for narrative, headings, analysis and conclusions.",
      "- Be specific and data-rich.",
      "- Cite tick numbers, agent ids, event counts, action types, and concrete state changes when available.",
      "- Highlight public vs targeted/private communication if present.",
      "- The 执行结论 section must directly answer the planning question.",
      "- Keep it readable as a final simulation result, not as developer documentation.",
      "- Return Markdown only.",
      "",
      "Basic run report:",
      basicReport,
      "",
      "Simulation artifact digest:",
      JSON.stringify(digest),
    ].join("\n"),
  });
  return normalizeBackendContent(raw);
}

async function buildReportDigest(runDirectory: string): Promise<unknown> {
  const manifest = JSON.parse(await readFile(join(runDirectory, "run.json"), "utf8")) as RunManifest;
  const metrics = JSON.parse(await readFile(join(runDirectory, "metrics.json"), "utf8")) as unknown;
  const graph = JSON.parse(await readFile(join(runDirectory, "graph.json"), "utf8")) as unknown;
  const timeline = JSON.parse(await readFile(join(runDirectory, "timeline.json"), "utf8")) as unknown[];
  const tickNames = (await readdir(join(runDirectory, "ticks"))).filter((name) => name.endsWith(".json")).sort(naturalSort);
  const ticks = [];
  for (const name of tickNames) {
    const tick = JSON.parse(await readFile(join(runDirectory, "ticks", name), "utf8")) as {
      tick: number;
      decisions: Array<{ agentId: string; decision: { thought: string; actions: Array<Record<string, unknown>> } }>;
      events: Array<Record<string, unknown>>;
    };
    ticks.push({
      tick: tick.tick,
      decisions: tick.decisions.map((item) => ({
        agentId: item.agentId,
        thought: item.decision.thought,
        actions: item.decision.actions.map(summarizeAction),
      })),
      events: tick.events.map(summarizeEvent),
    });
  }
  const latestSnapshotName = (await readdir(join(runDirectory, "snapshots"))).filter((name) => name.endsWith(".json")).sort(naturalSort).at(-1);
  const latestSnapshot = latestSnapshotName
    ? JSON.parse(await readFile(join(runDirectory, "snapshots", latestSnapshotName), "utf8")) as {
      tick: number;
      agents: unknown[];
      entities: unknown[];
      relations: unknown[];
      events: unknown[];
      memory: unknown;
    }
    : undefined;

  return {
    manifest,
    metrics,
    graph,
    timeline,
    ticks,
    finalSnapshot: latestSnapshot
      ? {
        tick: latestSnapshot.tick,
        agents: latestSnapshot.agents,
        entities: latestSnapshot.entities,
        relations: latestSnapshot.relations,
        memory: latestSnapshot.memory,
        eventCount: latestSnapshot.events.length,
      }
      : undefined,
  };
}

function summarizeAction(action: Record<string, unknown>): Record<string, unknown> {
  return compactObject({
    type: action.type,
    targetId: action.targetId,
    entityId: action.entityId,
    visibility: action.visibility,
    message: truncateText(action.message),
    fact: truncateText(action.fact),
    patch: action.patch,
    trustDelta: action.trustDelta,
    affinityDelta: action.affinityDelta,
    reason: truncateText(action.reason),
  });
}

function summarizeEvent(event: Record<string, unknown>): Record<string, unknown> {
  const payload = event.payload && typeof event.payload === "object" ? event.payload as Record<string, unknown> : {};
  return compactObject({
    id: event.id,
    tick: event.tick,
    type: event.type,
    actorId: event.actorId,
    targetId: event.targetId,
    visibility: event.visibility,
    visibleTo: event.visibleTo,
    message: truncateText(payload.message),
    fact: truncateText(payload.fact),
    patch: payload.patch,
    trustDelta: payload.trustDelta,
    affinityDelta: payload.affinityDelta,
    reason: truncateText(payload.reason),
  });
}

function compactObject(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function truncateText(value: unknown, max = 500): unknown {
  return typeof value === "string" && value.length > max ? `${value.slice(0, max - 1)}...` : value;
}

function naturalSort(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true });
}

function normalizeBackendContent(content: string): string {
  try {
    const parsed = JSON.parse(content) as { content?: unknown };
    if (typeof parsed.content === "string") return parsed.content;
  } catch {
    return content;
  }
  return content;
}
