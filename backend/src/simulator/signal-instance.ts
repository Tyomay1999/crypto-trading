import { scheduleSimulationSteps } from "./scheduler.js";
import type { ProjectionScenario, SimulationStep } from "./types.js";

export class SignalSimulationInstance {
  readonly #scenario: ProjectionScenario;
  readonly #steps: readonly SimulationStep[];
  #cursor = 0;

  constructor(scenario: ProjectionScenario) {
    this.#scenario = structuredClone(scenario);
    this.#steps = scheduleSimulationSteps(scenario.steps).map(({ step }) => step);
  }

  get signalId(): string { return this.#scenario.signalId; }
  get scenarioName(): string { return this.#scenario.name; }
  get seed(): string { return this.#scenario.seed; }

  peek(): SimulationStep | null {
    const step = this.#steps[this.#cursor];
    return step === undefined ? null : structuredClone(step);
  }

  take(): SimulationStep | null {
    const step = this.#steps[this.#cursor];
    if (step === undefined) return null;
    this.#cursor += 1;
    return structuredClone(step);
  }

  get complete(): boolean {
    return this.#cursor >= this.#steps.length;
  }
}
