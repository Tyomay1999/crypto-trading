import type { SimulationStep } from "./types.js";

export type ScheduledSimulationStep = Readonly<{
  ordinal: number;
  step: SimulationStep;
}>;

export function scheduleSimulationSteps(
  steps: readonly SimulationStep[],
): readonly ScheduledSimulationStep[] {
  return steps
    .map((step, ordinal) => ({ ordinal, step: structuredClone(step) }))
    .sort(
      (left, right) =>
        left.step.offsetMs - right.step.offsetMs ||
        left.ordinal - right.ordinal,
    );
}
