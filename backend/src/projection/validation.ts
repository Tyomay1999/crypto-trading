import {
  isLifecycleState,
  isTerminalStatus,
  type LifecycleState,
  type ProjectionJsonObject,
  type ProjectionJsonValue,
  type TerminalStatus,
} from "./contract.js";

const decimalPattern = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

export class ProjectionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectionValidationError";
  }
}

export function assertLifecycleState(value: unknown): asserts value is LifecycleState {
  if (!isLifecycleState(value)) throw new ProjectionValidationError("Unknown lifecycle state.");
}

export function assertTerminalStatus(value: unknown): asserts value is TerminalStatus {
  if (!isTerminalStatus(value)) throw new ProjectionValidationError("Unknown terminal status.");
}

export function assertDecimalString(value: unknown): asserts value is string {
  if (typeof value !== "string" || !decimalPattern.test(value)) {
    throw new ProjectionValidationError("Invalid decimal string.");
  }
}

export function assertOccurredAt(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || !Number.isFinite(Date.parse(value))) {
    throw new ProjectionValidationError("Invalid occurredAt timestamp.");
  }
}

export function assertProjectionJsonValue(
  value: unknown,
  path = "$",
): asserts value is ProjectionJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ProjectionValidationError(`Non-finite JSON number at ${path}.`);
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) assertProjectionJsonValue(value[i], `${path}[${i}]`);
    return;
  }
  if (typeof value === "object") {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      assertProjectionJsonValue(nested, `${path}.${key}`);
    }
    return;
  }
  throw new ProjectionValidationError(`Non-JSON value at ${path}.`);
}

export function assertProjectionJsonObject(value: unknown): asserts value is ProjectionJsonObject {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new ProjectionValidationError("Projection entity must be a JSON object.");
  }
  assertProjectionJsonValue(value);
}
