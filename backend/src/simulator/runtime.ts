import type { ProjectionWriter } from "../projection/writer.js";
import { buildProjectionWriterOperation } from "./projection-builder.js";
import { SignalSimulationInstance } from "./signal-instance.js";
import type { ProjectionScenario, SimulatorRuntimeOptions } from "./types.js";
import { VirtualClock } from "./virtual-clock.js";

type Candidate = Readonly<{
  instance: SignalSimulationInstance;
  offsetMs: number;
}>;

export class SimulatorRuntime {
  readonly #writer: ProjectionWriter;
  readonly #clock: VirtualClock;
  readonly #startEpochMs: number;
  readonly #seed: string;
  readonly #instances = new Map<string, SignalSimulationInstance>();

  constructor(writer: ProjectionWriter, options: SimulatorRuntimeOptions) {
    if (options.seed.length === 0) throw new Error("Simulator runtime seed must not be empty.");
    this.#writer = writer;
    this.#clock = new VirtualClock(options.startTime);
    this.#startEpochMs = this.#clock.nowEpochMs();
    this.#seed = options.seed;
  }

  get seed(): string { return this.#seed; }
  get clock(): VirtualClock { return this.#clock; }

  addScenario(scenario: ProjectionScenario): void {
    if (this.#instances.has(scenario.signalId)) {
      throw new Error(`Simulation signal already exists: ${scenario.signalId}`);
    }
    this.#instances.set(scenario.signalId, new SignalSimulationInstance(scenario));
  }

  async stepNext(): Promise<boolean> {
    const candidate = this.#nextCandidate();
    if (candidate === null) return false;

    const step = candidate.instance.take();
    if (step === null) return false;

    this.#clock.advanceTo(this.#startEpochMs + step.offsetMs);

    const operation = buildProjectionWriterOperation(step);
    const signalId = candidate.instance.signalId;

    switch (operation.kind) {
      case "publishSignal":
        await this.#writer.publishSignal(signalId, operation.payload);
        break;
      case "appendLifecycleEvent":
        await this.#writer.appendLifecycleEvent(signalId, operation.payload);
        break;
      case "updateSnapshot":
        await this.#writer.updateSnapshot(signalId, operation.payload);
        break;
      case "writeOutcome":
        await this.#writer.writeOutcome(signalId, operation.payload);
        break;
    }

    return true;
  }

  async runUntilIdle(): Promise<number> {
    let executed = 0;
    while (await this.stepNext()) executed += 1;
    return executed;
  }

  #nextCandidate(): Candidate | null {
    const candidates: Candidate[] = [];
    for (const instance of this.#instances.values()) {
      const step = instance.peek();
      if (step !== null) candidates.push({ instance, offsetMs: step.offsetMs });
    }

    candidates.sort(
      (left, right) =>
        left.offsetMs - right.offsetMs ||
        left.instance.signalId.localeCompare(right.instance.signalId) ||
        left.instance.scenarioName.localeCompare(right.instance.scenarioName),
    );

    return candidates[0] ?? null;
  }
}
