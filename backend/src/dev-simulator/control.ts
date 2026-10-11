import type { SignalProjection } from "../projection/contract.js";
import type { ProjectionWriter } from "../projection/writer.js";
import { SimulatorRuntime } from "../simulator/runtime.js";
import {
  createPublishScenario,
  createTransitionScenario,
} from "./scenarios.js";

export type DevLifecycleState =
  | "PUBLISHED"
  | "WAITING_FOR_ENTRY"
  | "ENTRY_REACHED"
  | "TP1_REACHED"
  | "TP2_REACHED"
  | "TP3_REACHED"
  | "STOP_REACHED";

export type DevSignalRecord = Readonly<{
  signalId: string;
  projection: SignalProjection;
  state: DevLifecycleState;
  sequence: number;
  terminal: boolean;
  entryReachedAt: string | null;
}>;

const NEXT: Readonly<Record<Exclude<DevLifecycleState, "TP3_REACHED" | "STOP_REACHED">, DevLifecycleState>> = {
  PUBLISHED: "WAITING_FOR_ENTRY",
  WAITING_FOR_ENTRY: "ENTRY_REACHED",
  ENTRY_REACHED: "TP1_REACHED",
  TP1_REACHED: "TP2_REACHED",
  TP2_REACHED: "TP3_REACHED",
};

const STOP_ALLOWED = new Set<DevLifecycleState>([
  "ENTRY_REACHED",
  "TP1_REACHED",
  "TP2_REACHED",
]);

const START_TIME = "2026-10-11T10:00:00.000Z";

export class DevSignalController {
  readonly #writer: ProjectionWriter;
  readonly #records = new Map<string, DevSignalRecord>();

  constructor(writer: ProjectionWriter) {
    this.#writer = writer;
  }

  list(): readonly DevSignalRecord[] {
    return [...this.#records.values()].map((record) => structuredClone(record));
  }

  get(signalId: string): DevSignalRecord | undefined {
    const record = this.#records.get(signalId);
    return record ? structuredClone(record) : undefined;
  }

  async publish(signalId: string, projection: SignalProjection): Promise<DevSignalRecord> {
    if (this.#records.has(signalId)) {
      throw new Error(`DEV signal already exists: ${signalId}`);
    }

    await this.#executeScenario(createPublishScenario(signalId, projection));

    const record: DevSignalRecord = {
      signalId,
      projection: structuredClone(projection),
      state: "PUBLISHED",
      sequence: 0,
      terminal: false,
      entryReachedAt: null,
    };
    this.#records.set(signalId, record);
    return structuredClone(record);
  }

  async next(signalId: string): Promise<DevSignalRecord> {
    const current = this.#requireActive(signalId);
    if (current.state === "TP3_REACHED" || current.state === "STOP_REACHED") {
      throw new Error(`Signal ${signalId} is terminal.`);
    }

    return this.#transition(current, NEXT[current.state]);
  }

  async stop(signalId: string): Promise<DevSignalRecord> {
    const current = this.#requireActive(signalId);
    if (!STOP_ALLOWED.has(current.state)) {
      throw new Error(`STOP is not allowed from ${current.state}.`);
    }
    return this.#transition(current, "STOP_REACHED");
  }

  #requireActive(signalId: string): DevSignalRecord {
    const record = this.#records.get(signalId);
    if (!record) throw new Error(`Unknown DEV signal: ${signalId}`);
    if (record.terminal) throw new Error(`Signal ${signalId} is terminal.`);
    return record;
  }

  async #transition(
    current: DevSignalRecord,
    toState: DevLifecycleState,
  ): Promise<DevSignalRecord> {
    const scenario = createTransitionScenario(current, toState);
    await this.#executeScenario(scenario);

    const sequence = current.sequence + 1;
    const updated: DevSignalRecord = {
      ...current,
      state: toState,
      sequence,
      terminal: toState === "TP3_REACHED" || toState === "STOP_REACHED",
      entryReachedAt:
        toState === "ENTRY_REACHED"
          ? new Date(Date.parse(START_TIME) + sequence * 1000).toISOString()
          : current.entryReachedAt,
    };
    this.#records.set(current.signalId, updated);
    return structuredClone(updated);
  }

  async #executeScenario(scenario: Parameters<SimulatorRuntime["addScenario"]>[0]): Promise<void> {
    const runtime = new SimulatorRuntime(this.#writer, {
      seed: scenario.seed,
      startTime: START_TIME,
    });
    runtime.addScenario(scenario);
    await runtime.runUntilIdle();
  }
}
