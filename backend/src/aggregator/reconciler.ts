import type {
  SignalLifecycleEvent,
  SignalProjection,
  SignalSnapshot,
} from "../projection/contract.js";
import type { JsonObject, ProjectionReader } from "../projection/reader.js";
import type { ProjectionWriter } from "../projection/writer.js";
import type { MappedProjectionBundle } from "./dr-mapper.js";

export interface ReconcileResult {
  readonly published: boolean;
  readonly eventsAppended: number;
  readonly snapshotUpdated: boolean;
  readonly outcomeWritten: boolean;
}

function fail(reason: string): never {
  throw new Error(
    `P11 projection reconciliation conflict: ${reason}`,
  );
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stable);
  }

  if (
    value !== null &&
    typeof value === "object"
  ) {
    const input = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};

    for (const key of Object.keys(input).sort()) {
      output[key] = stable(input[key]);
    }

    return output;
  }

  return value;
}

export function projectionJsonEqual(
  left: unknown,
  right: unknown,
): boolean {
  return (
    JSON.stringify(stable(left)) ===
    JSON.stringify(stable(right))
  );
}

function record(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    fail(`${label} is not an object`);
  }

  return value as Record<string, unknown>;
}

function string(
  value: unknown,
  label: string,
): string {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${label} is not a string`);
  }
  return value;
}

function nullableString(
  value: unknown,
  label: string,
): string | null {
  if (value === null) return null;
  return string(value, label);
}

function targetAllocations(
  projection: SignalProjection,
): Map<string, string> {
  const tradePlan = record(
    projection.tradePlan,
    "projection.tradePlan",
  );
  const targets = tradePlan.takeProfits;

  if (!Array.isArray(targets)) {
    fail("projection.tradePlan.takeProfits is not an array");
  }

  const result = new Map<string, string>();

  for (const raw of targets) {
    const target = record(raw, "takeProfit");
    result.set(
      string(target.label, "takeProfit.label"),
      string(
        target.allocationFraction,
        "takeProfit.allocationFraction",
      ),
    );
  }

  return result;
}

function parseUnsignedDecimal(
  value: string,
): { digits: bigint; scale: number } {
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
    fail(`allocation is not an unsigned decimal: ${value}`);
  }

  const [whole, fraction = ""] = value.split(".");
  return {
    digits: BigInt(`${whole}${fraction}`),
    scale: fraction.length,
  };
}

function formatScaled(
  digits: bigint,
  scale: number,
): string {
  if (digits < 0n) {
    fail("remaining allocation became negative");
  }

  if (scale === 0) return digits.toString();

  const factor = 10n ** BigInt(scale);
  const whole = digits / factor;
  const fraction = (digits % factor)
    .toString()
    .padStart(scale, "0")
    .replace(/0+$/u, "");

  return fraction.length === 0
    ? whole.toString()
    : `${whole}.${fraction}`;
}

function remainingAllocation(
  projection: SignalProjection,
  reachedTargets: readonly string[],
): string {
  const allocations = targetAllocations(projection);
  const parsed = reachedTargets.map((label) => {
    const allocation = allocations.get(label);
    if (allocation === undefined) {
      fail(`missing target allocation for ${label}`);
    }
    return parseUnsignedDecimal(allocation);
  });

  const maxScale = Math.max(
    0,
    ...parsed.map((value) => value.scale),
  );
  const one = 10n ** BigInt(maxScale);

  let reached = 0n;
  for (const value of parsed) {
    reached +=
      value.digits *
      10n ** BigInt(maxScale - value.scale);
  }

  return formatScaled(one - reached, maxScale);
}

export function deriveSnapshotFromTimeline(
  projection: SignalProjection,
  timeline: readonly SignalLifecycleEvent[],
): SignalSnapshot {
  if (timeline.length === 0) {
    fail("cannot derive snapshot from empty timeline");
  }

  const last = record(
    timeline[timeline.length - 1],
    "timeline last event",
  );
  const lifecycleState = string(
    last.toState,
    "timeline last event.toState",
  );
  const updatedAt = string(
    last.occurredAt,
    "timeline last event.occurredAt",
  );

  const entry = timeline.find(
    (event) => event.eventType === "ENTRY_REACHED",
  );

  const reachedTargets: string[] = [];
  for (const event of timeline) {
    const type = event.eventType;
    if (
      type === "TP1_REACHED" ||
      type === "TP2_REACHED" ||
      type === "TP3_REACHED"
    ) {
      reachedTargets.push(
        String(type).slice(0, 3),
      );
    }
  }

  const terminal =
    lifecycleState === "STOP_REACHED" ||
    lifecycleState === "TP3_REACHED";

  return {
    signalId: string(
      projection.signalId,
      "projection.signalId",
    ),
    lifecycleState,
    entryReachedAt:
      entry === undefined
        ? null
        : string(
            entry.occurredAt,
            "ENTRY_REACHED.occurredAt",
          ),
    actualEntryPrice:
      entry === undefined
        ? null
        : nullableString(
            entry.price,
            "ENTRY_REACHED.price",
          ),
    reachedTargets,
    remainingAllocationFraction:
      remainingAllocation(
        projection,
        reachedTargets,
      ),
    updatedAt,
    terminalAt:
      terminal ? updatedAt : null,
  };
}

function exactPrefixLength(
  existing: readonly JsonObject[],
  source: readonly SignalLifecycleEvent[],
): number {
  if (existing.length > source.length) {
    fail("destination event timeline is longer than DR source");
  }

  for (let index = 0; index < existing.length; index += 1) {
    if (!projectionJsonEqual(existing[index], source[index])) {
      fail(`destination event ${index + 1} differs from DR source`);
    }
  }

  return existing.length;
}

function currentMatchesAnySourcePrefix(
  current: JsonObject,
  projection: SignalProjection,
  timeline: readonly SignalLifecycleEvent[],
): boolean {
  for (let length = 1; length < timeline.length; length += 1) {
    const derived = deriveSnapshotFromTimeline(
      projection,
      timeline.slice(0, length),
    );

    if (projectionJsonEqual(current, derived)) {
      return true;
    }
  }

  return false;
}

export async function reconcileProjectionBundle(
  bundle: MappedProjectionBundle,
  reader: ProjectionReader,
  writer: ProjectionWriter,
): Promise<ReconcileResult> {
  const existing = await reader.getSignal(
    bundle.signalId,
  );

  let published = false;

  if (existing === null) {
    await writer.publishSignal(
      bundle.signalId,
      bundle.projection,
    );
    published = true;
  } else if (
    !projectionJsonEqual(
      existing.projection,
      bundle.projection,
    )
  ) {
    fail("published projection differs from authoritative DR mapping");
  }

  const existingEventsModel =
    await reader.getEvents(bundle.signalId);

  if (existingEventsModel === null) {
    fail("destination signal disappeared while reconciling events");
  }

  const prefixLength = exactPrefixLength(
    existingEventsModel.events,
    bundle.timeline,
  );

  let eventsAppended = 0;
  for (
    let index = prefixLength;
    index < bundle.timeline.length;
    index += 1
  ) {
    await writer.appendLifecycleEvent(
      bundle.signalId,
      bundle.timeline[index],
    );
    eventsAppended += 1;
  }

  const refreshed = await reader.getSignal(
    bundle.signalId,
  );

  if (refreshed === null) {
    fail("destination signal disappeared after event reconciliation");
  }

  let snapshotUpdated = false;

  if (refreshed.current === null) {
    await writer.updateSnapshot(
      bundle.signalId,
      bundle.snapshot,
    );
    snapshotUpdated = true;
  } else if (
    !projectionJsonEqual(
      refreshed.current,
      bundle.snapshot,
    )
  ) {
    if (
      !currentMatchesAnySourcePrefix(
        refreshed.current,
        bundle.projection,
        bundle.timeline,
      )
    ) {
      fail("destination snapshot is not a valid source timeline prefix");
    }

    await writer.updateSnapshot(
      bundle.signalId,
      bundle.snapshot,
    );
    snapshotUpdated = true;
  }

  const refreshedOutcome =
    await reader.getOutcome(bundle.signalId);

  if (refreshedOutcome === null) {
    fail("destination signal disappeared while reconciling outcome");
  }

  let outcomeWritten = false;

  if (bundle.outcome === null) {
    if (refreshedOutcome.outcome !== null) {
      fail("destination has terminal outcome absent from DR source");
    }
  } else if (refreshedOutcome.outcome === null) {
    await writer.writeOutcome(
      bundle.signalId,
      bundle.outcome,
    );
    outcomeWritten = true;
  } else if (
    !projectionJsonEqual(
      refreshedOutcome.outcome,
      bundle.outcome,
    )
  ) {
    fail("destination terminal outcome differs from DR source");
  }

  return Object.freeze({
    published,
    eventsAppended,
    snapshotUpdated,
    outcomeWritten,
  });
}
