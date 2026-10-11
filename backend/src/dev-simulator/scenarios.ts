import type {
  SignalLifecycleEvent,
  SignalOutcome,
  SignalProjection,
  SignalSnapshot,
} from "../projection/contract.js";
import type { ProjectionScenario, SimulationStep } from "../simulator/types.js";
import type {
  DevLifecycleState,
  DevSignalRecord,
} from "./control.js";

const BASE_TIME_ISO = "2026-10-11T10:00:00.000Z";
const BASE_TIME_MS = Date.parse(BASE_TIME_ISO);

function isoForSequence(sequence: number): string {
  return new Date(BASE_TIME_MS + sequence * 1000).toISOString();
}

function entryReachedAtFor(record: DevSignalRecord, toState: DevLifecycleState, sequence: number): string | null {
  if (toState === "ENTRY_REACHED") {
    return isoForSequence(sequence);
  }
  return record.entryReachedAt;
}

function reachedTargets(
  state: DevLifecycleState,
  fromState?: DevLifecycleState,
): string[] {
  if (state === "STOP_REACHED") {
    switch (fromState) {
      case "TP2_REACHED":
        return ["TP1", "TP2"];
      case "TP1_REACHED":
        return ["TP1"];
      case "ENTRY_REACHED":
        return [];
      default:
        throw new Error(`STOP_REACHED requires a valid pre-terminal state, got ${String(fromState)}.`);
    }
  }

  switch (state) {
    case "TP3_REACHED":
      return ["TP1", "TP2", "TP3"];
    case "TP2_REACHED":
      return ["TP1", "TP2"];
    case "TP1_REACHED":
      return ["TP1"];
    default:
      return [];
  }
}

export function createDemoProjection(
  signalId: string,
  symbol = "BTCUSDT",
  direction: "LONG" | "SHORT" = "LONG",
): SignalProjection {
  return {
    signalId,
    exchange: "binance",
    market: "usdm_futures",
    symbol,
    direction,
    publishedAt: BASE_TIME_ISO,
    expiresAt: "2026-10-12T10:00:00.000Z",
    strategy: {
      strategyId: "dev-p13",
      strategyVersion: "1",
    },
    tradePlan: {
      entry: {
        referencePrice: "118500",
        basis: "REFERENCE",
      },
      entryZone: {
        lower: "118400",
        upper: "118600",
        inclusive: true,
      },
      stopLoss: {
        price: "117900",
        reasonCode: "DEV_SCENARIO",
      },
      takeProfits: [
        { label: "TP1", price: "119000", allocationFraction: "0.30" },
        { label: "TP2", price: "119500", allocationFraction: "0.30" },
        { label: "TP3", price: "120000", allocationFraction: "0.40" },
      ],
    },
  };
}

export function createPublishScenario(
  signalId: string,
  projection: SignalProjection,
): ProjectionScenario {
  return {
    name: `DEV_PUBLISH_${signalId}`,
    signalId,
    seed: `dev-publish:${signalId}`,
    steps: [
      {
        kind: "publishSignal",
        offsetMs: 0,
        projection: structuredClone(projection),
      },
    ],
  };
}

export function createTransitionPayload(
  record: DevSignalRecord,
  fromState: DevLifecycleState,
  toState: DevLifecycleState,
  sequence: number,
): Readonly<{
  event: SignalLifecycleEvent;
  snapshot: SignalSnapshot;
  outcome?: SignalOutcome;
}> {
  const occurredAt = isoForSequence(sequence);
  const entryReachedAt = entryReachedAtFor(record, toState, sequence);

  const event: SignalLifecycleEvent = {
    eventId: `${record.signalId}:dev:${sequence}`,
    signalId: record.signalId,
    sequence,
    eventType: toState,
    fromState,
    toState,
    occurredAt,
    price:
      toState === "ENTRY_REACHED"
        ? "118520"
        : toState === "TP1_REACHED"
          ? "119000"
          : toState === "TP2_REACHED"
            ? "119500"
            : toState === "TP3_REACHED"
              ? "120000"
              : toState === "STOP_REACHED"
                ? "117900"
                : null,
    allocationFraction:
      toState === "TP1_REACHED"
        ? "0.30"
        : toState === "TP2_REACHED"
          ? "0.30"
          : toState === "TP3_REACHED"
            ? "0.40"
            : null,
    reasonCodes: ["DEV_SIMULATOR"],
    sourceVersion: "p13-dev-v1",
  };

  const targets = reachedTargets(toState, fromState);
  const snapshot: SignalSnapshot = {
    signalId: record.signalId,
    lifecycleState: toState,
    entryReachedAt,
    actualEntryPrice: entryReachedAt === null ? null : "118520",
    reachedTargets: targets,
    remainingAllocationFraction:
      toState === "TP1_REACHED"
        ? "0.70"
        : toState === "TP2_REACHED"
          ? "0.40"
          : toState === "TP3_REACHED"
            ? "0"
            : toState === "STOP_REACHED"
              ? targets.length === 2
                ? "0.40"
                : targets.length === 1
                  ? "0.70"
                  : "1"
              : "1",
    updatedAt: occurredAt,
    terminalAt:
      toState === "TP3_REACHED" || toState === "STOP_REACHED"
        ? occurredAt
        : null,
  };

  if (toState !== "TP3_REACHED" && toState !== "STOP_REACHED") {
    return { event, snapshot };
  }

  const outcome: SignalOutcome = {
    signalId: record.signalId,
    finalStatus: toState === "TP3_REACHED" ? "TP3" : "STOP",
    qualityStatus: "COMPLETE",
    asOf: occurredAt,
    entry: {
      referencePrice: "118500",
      actualEntryPrice: "118520",
    },
    reachedTargets: targets,
    underlyingReturn: "0",
    modeledLeveragedReturn: "0",
    netModeledReturn: "0",
    mfe: "0",
    mae: "0",
    fees: "0",
    slippage: "0",
    funding: "0",
    reasonCodes: ["DEV_SIMULATOR"],
  };

  return { event, snapshot, outcome };
}

export function createTransitionScenario(
  record: DevSignalRecord,
  toState: DevLifecycleState,
): ProjectionScenario {
  const sequence = record.sequence + 1;
  const payload = createTransitionPayload(record, record.state, toState, sequence);
  const steps: SimulationStep[] = [
    {
      kind: "appendLifecycleEvent",
      offsetMs: 0,
      event: payload.event,
    },
    {
      kind: "updateSnapshot",
      offsetMs: 0,
      snapshot: payload.snapshot,
    },
  ];

  if (payload.outcome) {
    steps.push({
      kind: "writeOutcome",
      offsetMs: 0,
      outcome: payload.outcome,
    });
  }

  return {
    name: `DEV_TRANSITION_${record.signalId}_${sequence}`,
    signalId: record.signalId,
    seed: `dev-transition:${record.signalId}:${sequence}`,
    steps,
  };
}
