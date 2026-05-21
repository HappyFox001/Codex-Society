import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunManifest } from "./artifacts.js";

export async function generateReport(runDirectory: string): Promise<string> {
  const manifest = JSON.parse(await readFile(join(runDirectory, "run.json"), "utf8")) as RunManifest;
  const metrics = JSON.parse(await readFile(join(runDirectory, "metrics.json"), "utf8")) as {
    tick: number;
    eventCount: number;
    agentCount: number;
    relationCount: number;
  };
  const report = `# Society Run Report

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
  await writeFile(join(runDirectory, "REPORT.md"), report, "utf8");
  return report;
}
