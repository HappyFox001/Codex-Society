# Trump China Pre-Visit Simulation Target

This simulation target builds a Codex Society case around a pre-visit planning question:

> Before Trump's May 14-15, 2026 China visit, what should the Trump-side delegation expect to negotiate and prioritize?

The simulation intentionally includes only Trump-side roles. It does not create Chinese official/persona agents.

## Source Basis

Public reporting before the visit pointed to these likely agenda areas:

- Trade truce maintenance, tariff relief, fentanyl enforcement, soybean/agricultural purchases and rare earth flows.
- Iran war spillover, Taiwan, AI, nuclear weapons and critical minerals.
- Commercial announcements around Boeing aircraft, agriculture, energy and U.S. business access.

Sources used while building the target:

- Reuters via KSL: Trump and China set for talks spanning Iran, nuclear, trade and AI.
- Reuters via Investing.com: Trump-Xi set for Beijing talks with trade truce, Iran war at stake.
- AP: Trump arrives in Beijing for talks on Iran war, trade and U.S. arms sales to Taiwan.
- CBS News: Trump's China trip agenda preview.

## Run In Society Shell

From the repo root:

```bash
pnpm run cli
```

Then choose:

```text
1  Simulate target
```

Select `trump-china-previsit`, then accept or edit the tick count.

Automation command mode is still available:

```bash
pnpm run cli -- init --template-dir simulations/trump-china-previsit
```

The generated artifacts live in `runs/trump-china-previsit/<run-id>/` from the repository root.
