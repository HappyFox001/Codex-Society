import { DefaultObservationProjector, type ObservationProjector } from "./observation.js";
import { RoundRobinSchedule, type SchedulePlan } from "./scheduler.js";
import type { AgentDecision, AgentId, SimulationReport, WorldEvent } from "./types.js";
import { actionSchema } from "./types.js";
import { WorldState } from "./world.js";
import type { AgentRuntime } from "../runtime/agent-runtime.js";

export interface SimulatorOptions {
  world: WorldState;
  runtime: AgentRuntime;
  projector?: ObservationProjector;
  schedule?: SchedulePlan;
  continueOnAgentError?: boolean;
  onAgentStart?: (event: { tick: number; agentId: AgentId }) => void | Promise<void>;
  onAgentDecision?: (event: { tick: number; agentId: AgentId; decision: AgentDecision; events: WorldEvent[] }) => void | Promise<void>;
  onAgentError?: (event: { tick: number; agentId: AgentId; error: unknown }) => void | Promise<void>;
}

export class SocietySimulator {
  private readonly world: WorldState;
  private readonly runtime: AgentRuntime;
  private readonly projector: ObservationProjector;
  private readonly schedule: SchedulePlan;
  private readonly continueOnAgentError: boolean;
  private readonly onAgentStart?: SimulatorOptions["onAgentStart"];
  private readonly onAgentDecision?: SimulatorOptions["onAgentDecision"];
  private readonly onAgentError?: SimulatorOptions["onAgentError"];

  constructor(options: SimulatorOptions) {
    this.world = options.world;
    this.runtime = options.runtime;
    this.projector = options.projector ?? new DefaultObservationProjector();
    this.schedule = options.schedule ?? new RoundRobinSchedule();
    this.continueOnAgentError = options.continueOnAgentError ?? false;
    this.onAgentStart = options.onAgentStart;
    this.onAgentDecision = options.onAgentDecision;
    this.onAgentError = options.onAgentError;
  }

  async runTicks(count: number): Promise<SimulationReport[]> {
    const reports: SimulationReport[] = [];
    for (let index = 0; index < count; index += 1) {
      reports.push(await this.runTick());
    }
    return reports;
  }

  async runTick(): Promise<SimulationReport> {
    const tick = this.world.advanceTick();
    const agentIds = this.world.getAgents().map((agent) => agent.id);
    const activeAgentIds = this.schedule.agentsForTick(tick, agentIds);
    const decisions: SimulationReport["decisions"] = [];
    const emittedEvents: WorldEvent[] = [];

    for (const agentId of activeAgentIds) {
      try {
        await this.onAgentStart?.({ tick, agentId });
        const decision = await this.decide(agentId);
        decisions.push({ agentId, decision });

        const agentEvents: WorldEvent[] = [];
        for (const action of decision.actions) {
          const parsed = actionSchema.parse(action);
          this.assertActionAllowed(agentId, parsed.type);
          const event = this.world.applyAction(agentId, parsed);
          if (event) {
            agentEvents.push(event);
            emittedEvents.push(event);
          }
        }
        await this.onAgentDecision?.({ tick, agentId, decision, events: agentEvents });
      } catch (error) {
        await this.onAgentError?.({ tick, agentId, error });
        if (!this.continueOnAgentError) {
          throw error;
        }

        const event = this.world.applyAction(agentId, {
          type: "noop",
          reason: error instanceof Error ? error.message : "Unknown agent runtime error",
        });
        if (event) {
          emittedEvents.push(event);
        }
      }
    }

    return {
      tick,
      decisions,
      events: emittedEvents,
    };
  }

  snapshot() {
    return this.world.snapshot();
  }

  private async decide(agentId: AgentId): Promise<AgentDecision> {
    const observation = this.projector.project(this.world.snapshot(), agentId);
    return this.runtime.decide(observation);
  }

  private assertActionAllowed(agentId: AgentId, actionType: string): void {
    const agent = this.world.getAgent(agentId);
    if (!agent.toolPermissions.includes(actionType)) {
      throw new Error(`Agent ${agentId} is not allowed to execute action: ${actionType}`);
    }
  }
}
