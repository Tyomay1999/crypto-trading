import type {
  SignalLifecycleEvent,
  SignalOutcome,
  SignalProjection,
  SignalSnapshot,
} from "../projection/contract.js";
import type { SimulationStep } from "./types.js";

export type ProjectionWriterOperation =
  | Readonly<{ kind: "publishSignal"; payload: SignalProjection }>
  | Readonly<{ kind: "appendLifecycleEvent"; payload: SignalLifecycleEvent }>
  | Readonly<{ kind: "updateSnapshot"; payload: SignalSnapshot }>
  | Readonly<{ kind: "writeOutcome"; payload: SignalOutcome }>;

/**
 * Simulator reproduces prepared DR domain output. It does not reconstruct DR
 * feature/fold/observation internals.
 */
export function buildProjectionWriterOperation(
  step: SimulationStep,
): ProjectionWriterOperation {
  switch (step.kind) {
    case "publishSignal":
      return { kind: step.kind, payload: structuredClone(step.projection) };
    case "appendLifecycleEvent":
      return { kind: step.kind, payload: structuredClone(step.event) };
    case "updateSnapshot":
      return { kind: step.kind, payload: structuredClone(step.snapshot) };
    case "writeOutcome":
      return { kind: step.kind, payload: structuredClone(step.outcome) };
  }
}
