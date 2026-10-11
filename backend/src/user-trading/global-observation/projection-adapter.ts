import type {
  JsonObject,
  ProjectionReader,
} from "../../projection/reader.js";
import type {
  GlobalSignalObservation,
} from "./types.js";

function object(
  value: unknown,
  label: string,
): JsonObject {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new TypeError(`${label} must be an object`);
  }

  return value as JsonObject;
}

function text(
  source: JsonObject,
  key: string,
  label: string,
): string {
  const value = source[key];

  if (
    typeof value !== "string" ||
    value.length === 0
  ) {
    throw new TypeError(`${label}.${key} must be a nonempty string`);
  }

  return value;
}

function optionalText(
  source: JsonObject,
  key: string,
): string | null {
  const value = source[key];
  return typeof value === "string" && value.length > 0
    ? value
    : null;
}

function targetFromState(
  state: string,
): "TP1" | "TP2" | "TP3" | null {
  if (state === "TP1_REACHED") return "TP1";
  if (state === "TP2_REACHED") return "TP2";
  if (state === "TP3_REACHED") return "TP3";
  return null;
}

function requireCanonicalEvent(
  event: JsonObject,
): JsonObject {
  const canonical = event.canonical;
  return canonical === undefined
    ? event
    : object(canonical, "event.canonical");
}

function eventIdentity(
  event: JsonObject,
  canonical: JsonObject,
): string {
  return (
    optionalText(canonical, "signalLifecycleEventId") ??
    optionalText(event, "eventIdentity") ??
    optionalText(event, "eventId") ??
    (() => {
      throw new TypeError("projection event identity is missing");
    })()
  );
}

function sequence(
  event: JsonObject,
  canonical: JsonObject,
): string {
  const value =
    canonical.sequence ??
    event.sequence;

  if (
    typeof value !== "string" &&
    typeof value !== "number"
  ) {
    throw new TypeError("projection event sequence is missing");
  }

  return String(value);
}

function lifecycleState(
  event: JsonObject,
  canonical: JsonObject,
): string {
  return (
    optionalText(canonical, "state") ??
    optionalText(canonical, "toState") ??
    optionalText(event, "state") ??
    optionalText(event, "toState") ??
    (() => {
      throw new TypeError("projection lifecycle state is missing");
    })()
  );
}

function occurredAt(
  event: JsonObject,
  canonical: JsonObject,
): string {
  return (
    optionalText(canonical, "occurredAt") ??
    optionalText(event, "occurredAt") ??
    (() => {
      throw new TypeError("projection event occurredAt is missing");
    })()
  );
}

function eventPrice(
  event: JsonObject,
  canonical: JsonObject,
): string {
  return (
    optionalText(canonical, "price") ??
    optionalText(event, "price") ??
    (() => {
      throw new TypeError("projection target event price is missing");
    })()
  );
}

function allocationFraction(
  event: JsonObject,
  canonical: JsonObject,
): string {
  const candidates = [
    canonical.allocationFraction,
    canonical.allocation,
    event.allocationFraction,
    event.allocation,
  ];

  for (const value of candidates) {
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }

  throw new TypeError(
    "projection target allocation fraction is missing",
  );
}

export function mapProjectionLifecycleEvent(
  signalId: string,
  input: JsonObject,
): GlobalSignalObservation | null {
  const event = object(input, "projection lifecycle event");
  const canonical = requireCanonicalEvent(event);
  const state = lifecycleState(event, canonical);

  const target = targetFromState(state);

  if (target !== null) {
    return Object.freeze({
      kind: "TARGET_REACHED",
      signalId,
      globalEventIdentity:
        eventIdentity(event, canonical),
      globalSequence:
        sequence(event, canonical),
      occurredAt:
        occurredAt(event, canonical),
      state:
        state as
          | "TP1_REACHED"
          | "TP2_REACHED"
          | "TP3_REACHED",
      target,
      price:
        eventPrice(event, canonical),
      allocationFraction:
        allocationFraction(event, canonical),
    });
  }

  if (state === "STOP_REACHED") {
    return Object.freeze({
      kind: "STOP_REACHED",
      signalId,
      globalEventIdentity:
        eventIdentity(event, canonical),
      globalSequence:
        sequence(event, canonical),
      occurredAt:
        occurredAt(event, canonical),
      state: "STOP_REACHED",
    });
  }

  return null;
}

export function mapProjectionOutcome(
  signalId: string,
  input: JsonObject,
): GlobalSignalObservation {
  const outcome = object(input, "projection outcome");
  const canonical =
    outcome.canonical === undefined
      ? outcome
      : object(outcome.canonical, "outcome.canonical");

  const finalStatus =
    optionalText(canonical, "finalStatus") ??
    optionalText(outcome, "finalStatus");

  if (
    finalStatus !== "STOP" &&
    finalStatus !== "TP3"
  ) {
    throw new TypeError("unsupported projection terminal status");
  }

  const observedAt =
    optionalText(canonical, "asOf") ??
    optionalText(outcome, "asOf") ??
    optionalText(canonical, "occurredAt") ??
    optionalText(outcome, "occurredAt");

  if (observedAt === null) {
    throw new TypeError("projection outcome timestamp is missing");
  }

  return Object.freeze({
    kind: "GLOBAL_OUTCOME",
    signalId,
    globalEventIdentity:
      `global-outcome:${signalId}:${finalStatus}:${observedAt}`,
    occurredAt: observedAt,
    finalStatus,
  });
}

export class ProjectionGlobalObservationProvider {
  constructor(
    private readonly reader: ProjectionReader,
  ) {}

  async readSignalObservations(
    signalId: string,
  ): Promise<readonly GlobalSignalObservation[]> {
    const events = await this.reader.getEvents(signalId);

    if (events === null) {
      return Object.freeze([]);
    }

    const mapped: GlobalSignalObservation[] = [];

    for (const event of events.events) {
      const observation =
        mapProjectionLifecycleEvent(
          signalId,
          event,
        );

      if (observation !== null) {
        mapped.push(observation);
      }
    }

    const outcome =
      await this.reader.getOutcome(signalId);

    if (outcome?.outcome) {
      mapped.push(
        mapProjectionOutcome(
          signalId,
          outcome.outcome,
        ),
      );
    }

    return Object.freeze(mapped);
  }
}
