/**
 * DELTA Projection Contract v1 boundary.
 *
 * The authoritative JSON Schema is vendored beside this file and protected by
 * its frozen SHA256. P5A deliberately does not invent unproven field shapes.
 */
export const PROJECTION_CONTRACT_V1_SCHEMA_SHA256 =
  "dbdd0af64715596f705f3dff74f368fd1815dc26e22f326ddba10b400fa9dfa1" as const;

export const LIFECYCLE_STATES = [
  "PUBLISHED",
  "WAITING_FOR_ENTRY",
  "ENTRY_REACHED",
  "TP1_REACHED",
  "TP2_REACHED",
  "TP3_REACHED",
  "STOP_REACHED",
] as const;
export type LifecycleState = (typeof LIFECYCLE_STATES)[number];

export const TERMINAL_STATUSES = ["STOP", "TP3"] as const;
export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];

export type ProjectionJsonPrimitive = string | number | boolean | null;
export type ProjectionJsonValue =
  | ProjectionJsonPrimitive
  | ProjectionJsonObject
  | readonly ProjectionJsonValue[];
export type ProjectionJsonObject = {
  readonly [key: string]: ProjectionJsonValue;
};

export type SignalProjection = ProjectionJsonObject;
export type SignalLifecycleEvent = ProjectionJsonObject;
export type SignalSnapshot = ProjectionJsonObject;
export type SignalOutcome = ProjectionJsonObject;
export type SignalId = string;

export function isLifecycleState(value: unknown): value is LifecycleState {
  return typeof value === "string" &&
    (LIFECYCLE_STATES as readonly string[]).includes(value);
}

export function isTerminalStatus(value: unknown): value is TerminalStatus {
  return typeof value === "string" &&
    (TERMINAL_STATUSES as readonly string[]).includes(value);
}
