import type {
  SignalId,
  SignalLifecycleEvent,
  SignalOutcome,
  SignalProjection,
  SignalSnapshot,
} from "./contract.js";

export interface ProjectionWriter {
  publishSignal(signalId: SignalId, projection: SignalProjection): Promise<void>;
  appendLifecycleEvent(signalId: SignalId, event: SignalLifecycleEvent): Promise<void>;
  updateSnapshot(signalId: SignalId, snapshot: SignalSnapshot): Promise<void>;
  writeOutcome(signalId: SignalId, outcome: SignalOutcome): Promise<void>;
}
