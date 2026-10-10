import { assertProjectionJsonObject } from "../projection/validation.js";
import type { ProjectionScenario, SimulationStep } from "./types.js";

const stepKinds = new Set([
  "publishSignal",
  "appendLifecycleEvent",
  "updateSnapshot",
  "writeOutcome",
]);

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid scenario ${field}.`);
  }
  return value;
}

function requireOffset(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("Invalid scenario step offsetMs.");
  }
  return value;
}

function loadStep(value: unknown): SimulationStep {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error("Scenario step must be an object.");
  }

  const raw = value as Record<string, unknown>;
  const kind = requireString(raw.kind, "step kind");
  if (!stepKinds.has(kind)) throw new Error(`Unknown scenario step kind: ${kind}`);
  const offsetMs = requireOffset(raw.offsetMs);

  if (kind === "publishSignal") {
    assertProjectionJsonObject(raw.projection);
    return { kind, offsetMs, projection: structuredClone(raw.projection) };
  }

  if (kind === "appendLifecycleEvent") {
    assertProjectionJsonObject(raw.event);
    return { kind, offsetMs, event: structuredClone(raw.event) };
  }

  if (kind === "updateSnapshot") {
    assertProjectionJsonObject(raw.snapshot);
    return { kind, offsetMs, snapshot: structuredClone(raw.snapshot) };
  }

  assertProjectionJsonObject(raw.outcome);
  return { kind: "writeOutcome", offsetMs, outcome: structuredClone(raw.outcome) };
}

export function loadProjectionScenario(value: unknown): ProjectionScenario {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error("Scenario must be an object.");
  }

  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.steps) || raw.steps.length === 0) {
    throw new Error("Scenario requires at least one step.");
  }

  const steps = raw.steps.map(loadStep);
  for (let index = 1; index < steps.length; index += 1) {
    if (steps[index].offsetMs < steps[index - 1].offsetMs) {
      throw new Error("Scenario steps must be ordered by offsetMs.");
    }
  }

  if (steps[0].kind !== "publishSignal") {
    throw new Error("Scenario must begin with publishSignal.");
  }

  return {
    name: requireString(raw.name, "name"),
    signalId: requireString(raw.signalId, "signalId"),
    seed: requireString(raw.seed, "seed"),
    steps,
  };
}
