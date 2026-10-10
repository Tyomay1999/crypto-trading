import type {
  SignalId,
  SignalLifecycleEvent,
  SignalOutcome,
  SignalProjection,
  SignalSnapshot,
} from "./contract.js";
import type { ProjectionWriter } from "./writer.js";

export type InMemoryProjectionRecord = Readonly<{
  signalId: SignalId;
  projection: SignalProjection;
  timeline: readonly SignalLifecycleEvent[];
  snapshot: SignalSnapshot | null;
  outcome: SignalOutcome | null;
}>;

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class InMemoryProjectionWriter implements ProjectionWriter {
  readonly #records = new Map<SignalId, InMemoryProjectionRecord>();

  async publishSignal(signalId: SignalId, projection: SignalProjection): Promise<void> {
    if (this.#records.has(signalId)) throw new Error(`Signal already published: ${signalId}`);
    this.#records.set(signalId, {
      signalId,
      projection: clone(projection),
      timeline: [],
      snapshot: null,
      outcome: null,
    });
  }

  async appendLifecycleEvent(signalId: SignalId, event: SignalLifecycleEvent): Promise<void> {
    const record = this.#require(signalId);
    this.#records.set(signalId, { ...record, timeline: [...record.timeline, clone(event)] });
  }

  async updateSnapshot(signalId: SignalId, snapshot: SignalSnapshot): Promise<void> {
    const record = this.#require(signalId);
    this.#records.set(signalId, { ...record, snapshot: clone(snapshot) });
  }

  async writeOutcome(signalId: SignalId, outcome: SignalOutcome): Promise<void> {
    const record = this.#require(signalId);
    if (record.outcome !== null) throw new Error(`Signal outcome already exists: ${signalId}`);
    this.#records.set(signalId, { ...record, outcome: clone(outcome) });
  }

  readSignal(signalId: SignalId): InMemoryProjectionRecord | null {
    const record = this.#records.get(signalId);
    return record === undefined ? null : clone(record);
  }

  listSignals(): readonly InMemoryProjectionRecord[] {
    return [...this.#records.values()]
      .sort((a, b) => a.signalId.localeCompare(b.signalId))
      .map((record) => clone(record));
  }

  #require(signalId: SignalId): InMemoryProjectionRecord {
    const record = this.#records.get(signalId);
    if (record === undefined) throw new Error(`Signal has not been published: ${signalId}`);
    return record;
  }
}
