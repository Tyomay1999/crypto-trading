import type {
  SignalId,
  SignalLifecycleEvent,
  SignalOutcome,
  SignalProjection,
  SignalSnapshot,
} from "../projection/contract.js";

export const ACCEPTED_SCENARIO_NAMES = [
  "ACTIVE_TP2",
  "TERMINAL_TP3",
  "STOP_AFTER_ENTRY",
  "STOP_AFTER_TP1",
  "STOP_AFTER_TP2",
] as const;

export type AcceptedScenarioName = (typeof ACCEPTED_SCENARIO_NAMES)[number];

type SimulationStepBase = Readonly<{ offsetMs: number }>;

export type PublishSignalStep = SimulationStepBase & Readonly<{
  kind: "publishSignal";
  projection: SignalProjection;
}>;

export type AppendLifecycleEventStep = SimulationStepBase & Readonly<{
  kind: "appendLifecycleEvent";
  event: SignalLifecycleEvent;
}>;

export type UpdateSnapshotStep = SimulationStepBase & Readonly<{
  kind: "updateSnapshot";
  snapshot: SignalSnapshot;
}>;

export type WriteOutcomeStep = SimulationStepBase & Readonly<{
  kind: "writeOutcome";
  outcome: SignalOutcome;
}>;

export type SimulationStep =
  | PublishSignalStep
  | AppendLifecycleEventStep
  | UpdateSnapshotStep
  | WriteOutcomeStep;

export type ProjectionScenario = Readonly<{
  name: string;
  signalId: SignalId;
  seed: string;
  steps: readonly SimulationStep[];
}>;

export type SimulatorRuntimeOptions = Readonly<{
  seed: string;
  startTime: string;
}>;
