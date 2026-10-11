import type {
  ProjectionJsonObject,
  SignalLifecycleEvent,
  SignalOutcome,
  SignalProjection,
  SignalSnapshot,
} from "../projection/contract.js";

type JsonRecord = Record<string, unknown>;

export interface MappedProjectionBundle {
  readonly signalId: string;
  readonly projection: SignalProjection;
  readonly timeline: readonly SignalLifecycleEvent[];
  readonly snapshot: SignalSnapshot;
  readonly outcome: SignalOutcome | null;
}

const decimalPattern =
  /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

const lifecycleStates = new Set([
  "PUBLISHED",
  "WAITING_FOR_ENTRY",
  "ENTRY_REACHED",
  "TP1_REACHED",
  "TP2_REACHED",
  "TP3_REACHED",
  "STOP_REACHED",
]);

const eventTypes = new Set([
  "SIGNAL_PUBLISHED",
  "WAITING_FOR_ENTRY",
  "ENTRY_REACHED",
  "TP1_REACHED",
  "TP2_REACHED",
  "TP3_REACHED",
  "STOP_REACHED",
]);

const allowedTransitions = new Set([
  "null->PUBLISHED",
  "PUBLISHED->WAITING_FOR_ENTRY",
  "WAITING_FOR_ENTRY->ENTRY_REACHED",
  "ENTRY_REACHED->TP1_REACHED",
  "TP1_REACHED->TP2_REACHED",
  "TP2_REACHED->TP3_REACHED",
  "ENTRY_REACHED->STOP_REACHED",
  "TP1_REACHED->STOP_REACHED",
  "TP2_REACHED->STOP_REACHED",
]);

function fail(label: string): never {
  throw new TypeError(`P11 DR mapping rejected: ${label}`);
}

function record(
  value: unknown,
  label: string,
): JsonRecord {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    fail(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function array(
  value: unknown,
  label: string,
): unknown[] {
  if (!Array.isArray(value)) {
    fail(`${label} must be an array`);
  }
  return value;
}

function string(
  value: unknown,
  label: string,
): string {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${label} must be a non-empty string`);
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

function integer(
  value: unknown,
  label: string,
): number {
  if (!Number.isSafeInteger(value)) {
    fail(`${label} must be a safe integer`);
  }
  return value as number;
}

function booleanValue(
  value: unknown,
  label: string,
): boolean {
  if (typeof value !== "boolean") {
    fail(`${label} must be boolean`);
  }
  return value;
}

function timestamp(
  value: unknown,
  label: string,
): string {
  const result = string(value, label);
  if (!Number.isFinite(Date.parse(result))) {
    fail(`${label} must be an RFC3339 timestamp`);
  }
  return result;
}

function decimalString(
  value: unknown,
  label: string,
): string {
  const result = string(value, label);
  if (!decimalPattern.test(result)) {
    fail(`${label} must be a decimal string`);
  }
  return result;
}

function drDecimal(
  value: unknown,
  label: string,
): string {
  const source = record(value, label);
  const keys = Object.keys(source);

  if (
    keys.length !== 1 ||
    keys[0] !== "$decimal"
  ) {
    fail(`${label} must be a canonical DR decimal`);
  }

  return decimalString(
    source.$decimal,
    `${label}.$decimal`,
  );
}

function nullableDrDecimal(
  value: unknown,
  label: string,
): string | null {
  if (value === null) return null;
  return drDecimal(value, label);
}

function stringArray(
  value: unknown,
  label: string,
): string[] {
  return array(value, label).map(
    (item, index) =>
      string(item, `${label}[${index}]`),
  );
}

function assertEqual(
  left: unknown,
  right: unknown,
  label: string,
): void {
  if (left !== right) {
    fail(`${label} mismatch`);
  }
}

function lifecycleState(
  value: unknown,
  label: string,
): string {
  const result = string(value, label);
  if (!lifecycleStates.has(result)) {
    fail(`${label} is not a P3 lifecycle state`);
  }
  return result;
}

function eventType(
  value: unknown,
  label: string,
): string {
  const result = string(value, label);
  if (!eventTypes.has(result)) {
    fail(`${label} is not a P3 event type`);
  }
  return result;
}

function assertContract(
  value: JsonRecord,
  name: string,
  versionKey: string,
  label: string,
): void {
  assertEqual(
    value.contractName,
    name,
    `${label}.contractName`,
  );
  assertEqual(
    value.contractVersion,
    1,
    `${label}.contractVersion`,
  );
  assertEqual(
    value[versionKey],
    1,
    `${label}.${versionKey}`,
  );
}

function marketContext(
  value: unknown,
  label: string,
): {
  exchange: string;
  market: string;
  symbol: string;
} {
  const context = record(value, label);
  return {
    exchange: string(
      context.exchange,
      `${label}.exchange`,
    ),
    market: string(
      context.market,
      `${label}.market`,
    ),
    symbol: string(
      context.symbol,
      `${label}.symbol`,
    ),
  };
}

function canonicalTargets(
  value: unknown,
  label: string,
): string[] {
  const targets = stringArray(value, label);
  const seen = new Set<string>();

  for (const target of targets) {
    if (!["TP1", "TP2", "TP3"].includes(target)) {
      fail(`${label} contains invalid target`);
    }
    if (seen.has(target)) {
      fail(`${label} contains duplicate target`);
    }
    seen.add(target);
  }

  return targets;
}

function arraysEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function mappedEventTargets(
  timeline: readonly ProjectionJsonObject[],
): string[] {
  const result: string[] = [];

  for (const event of timeline) {
    const type = event.eventType;
    if (
      type === "TP1_REACHED" ||
      type === "TP2_REACHED" ||
      type === "TP3_REACHED"
    ) {
      result.push(type.slice(0, 3));
    }
  }

  return result;
}

export function mapDrBundleToP3(
  input: Readonly<Record<string, unknown>>,
): MappedProjectionBundle {
  const lifecycle = record(
    input.lifecycle,
    "lifecycle",
  );
  const planMeta = record(
    input.planMeta,
    "planMeta",
  );
  const plan = record(
    input.plan,
    "plan",
  );
  const rawEvents = array(
    input.events,
    "events",
  );
  const stateMeta = record(
    input.stateMeta,
    "stateMeta",
  );
  const state = record(
    input.state,
    "state",
  );

  const signalId = string(
    lifecycle.signal_lifecycle_id,
    "lifecycle.signal_lifecycle_id",
  );
  const planId = string(
    lifecycle.paper_trade_plan_id,
    "lifecycle.paper_trade_plan_id",
  );
  const exchange = string(
    lifecycle.exchange,
    "lifecycle.exchange",
  );
  const market = string(
    lifecycle.market,
    "lifecycle.market",
  );
  const symbol = string(
    lifecycle.symbol,
    "lifecycle.symbol",
  );
  const publishedAt = timestamp(
    lifecycle.published_at,
    "lifecycle.published_at",
  );

  assertEqual(
    planMeta.paper_trade_plan_id,
    planId,
    "planMeta.paper_trade_plan_id",
  );
  assertEqual(
    planMeta.exchange,
    exchange,
    "planMeta.exchange",
  );
  assertEqual(
    planMeta.market,
    market,
    "planMeta.market",
  );
  assertEqual(
    planMeta.symbol,
    symbol,
    "planMeta.symbol",
  );

  assertContract(
    plan,
    "PaperTradePlan",
    "planSchemaVersion",
    "plan",
  );
  assertEqual(
    plan.paperTradePlanId,
    planId,
    "plan.paperTradePlanId",
  );

  const planMarket = marketContext(
    plan.marketContext,
    "plan.marketContext",
  );
  assertEqual(
    planMarket.exchange,
    exchange,
    "plan.marketContext.exchange",
  );
  assertEqual(
    planMarket.market,
    market,
    "plan.marketContext.market",
  );
  assertEqual(
    planMarket.symbol,
    symbol,
    "plan.marketContext.symbol",
  );

  const direction = string(
    plan.direction,
    "plan.direction",
  );
  if (direction !== "LONG" && direction !== "SHORT") {
    fail("plan.direction is not LONG or SHORT");
  }
  assertEqual(
    planMeta.direction,
    direction,
    "planMeta.direction",
  );

  const expiration = record(
    plan.expiration,
    "plan.expiration",
  );
  const expiresAt = timestamp(
    planMeta.expires_at,
    "planMeta.expires_at",
  );
  assertEqual(
    expiration.expiresAt,
    expiresAt,
    "plan.expiration.expiresAt",
  );

  const strategyLineage = array(
    plan.strategyLineage,
    "plan.strategyLineage",
  );

  if (strategyLineage.length !== 1) {
    fail(
      "plan.strategyLineage must contain exactly one observed v1 strategy",
    );
  }

  const strategy = record(
    strategyLineage[0],
    "plan.strategyLineage[0]",
  );

  const entry = record(
    plan.entry,
    "plan.entry",
  );
  const entryZone = record(
    plan.entryZone,
    "plan.entryZone",
  );
  const stopLoss = record(
    plan.stopLoss,
    "plan.stopLoss",
  );

  const rawTakeProfits = array(
    plan.takeProfits,
    "plan.takeProfits",
  );
  if (rawTakeProfits.length !== 3) {
    fail("plan.takeProfits must contain exactly TP1, TP2 and TP3");
  }

  const expectedLabels = ["TP1", "TP2", "TP3"];
  const takeProfits = rawTakeProfits.map(
    (value, index) => {
      const target = record(
        value,
        `plan.takeProfits[${index}]`,
      );
      const labelValue = string(
        target.label,
        `plan.takeProfits[${index}].label`,
      );

      assertEqual(
        labelValue,
        expectedLabels[index],
        `plan.takeProfits[${index}].label`,
      );

      return {
        label: labelValue,
        price: drDecimal(
          target.price,
          `plan.takeProfits[${index}].price`,
        ),
        allocationFraction: drDecimal(
          target.allocationFraction,
          `plan.takeProfits[${index}].allocationFraction`,
        ),
      };
    },
  );

  const projection: SignalProjection = {
    signalId,
    exchange,
    market,
    symbol,
    direction,
    publishedAt,
    expiresAt,
    strategy: {
      strategyId: string(
        strategy.strategyId,
        "plan.strategyLineage[0].strategyId",
      ),
      strategyVersion: string(
        strategy.strategyVersion,
        "plan.strategyLineage[0].strategyVersion",
      ),
    },
    tradePlan: {
      entry: {
        referencePrice: drDecimal(
          entry.price,
          "plan.entry.price",
        ),
        basis: string(
          entry.basis,
          "plan.entry.basis",
        ),
      },
      entryZone: {
        lower: drDecimal(
          entryZone.lower,
          "plan.entryZone.lower",
        ),
        upper: drDecimal(
          entryZone.upper,
          "plan.entryZone.upper",
        ),
        inclusive: booleanValue(
          entryZone.inclusive,
          "plan.entryZone.inclusive",
        ),
      },
      stopLoss: {
        price: drDecimal(
          stopLoss.price,
          "plan.stopLoss.price",
        ),
        reasonCode: string(
          stopLoss.reasonCode,
          "plan.stopLoss.reasonCode",
        ),
      },
      takeProfits,
    },
  };

  const timeline: ProjectionJsonObject[] = [];
  let previousToState: string | null = null;

  for (
    let index = 0;
    index < rawEvents.length;
    index += 1
  ) {
    const wrapper = record(
      rawEvents[index],
      `events[${index}]`,
    );
    const meta = record(
      wrapper.meta,
      `events[${index}].meta`,
    );
    const canonical = record(
      wrapper.canonical,
      `events[${index}].canonical`,
    );

    assertContract(
      canonical,
      "SignalLifecycleEvent",
      "eventSchemaVersion",
      `events[${index}].canonical`,
    );

    const sequence = integer(
      canonical.sequence,
      `events[${index}].canonical.sequence`,
    );
    if (sequence !== index + 1) {
      fail("event sequence must be contiguous and start at 1");
    }

    const canonicalSignalId = string(
      canonical.signalLifecycleId,
      `events[${index}].canonical.signalLifecycleId`,
    );
    assertEqual(
      canonicalSignalId,
      signalId,
      `events[${index}] signal identity`,
    );

    const id = string(
      canonical.signalLifecycleEventId,
      `events[${index}].canonical.signalLifecycleEventId`,
    );
    const type = eventType(
      canonical.eventType,
      `events[${index}].canonical.eventType`,
    );
    const fromState = nullableString(
      canonical.fromState,
      `events[${index}].canonical.fromState`,
    );
    const toState = lifecycleState(
      canonical.toState,
      `events[${index}].canonical.toState`,
    );
    const occurredAt = timestamp(
      canonical.occurredAt,
      `events[${index}].canonical.occurredAt`,
    );

    if (
      type === "SIGNAL_PUBLISHED"
        ? toState !== "PUBLISHED"
        : type !== toState
    ) {
      fail(`events[${index}] eventType/toState mismatch`);
    }

    if (fromState !== previousToState) {
      fail(`events[${index}] fromState does not match prior event`);
    }

    const transition = `${fromState ?? "null"}->${toState}`;
    if (!allowedTransitions.has(transition)) {
      fail(`events[${index}] transition is not observed P3 v1`);
    }

    previousToState = toState;

    assertEqual(
      meta.signal_lifecycle_event_id,
      id,
      `events[${index}].meta.signal_lifecycle_event_id`,
    );
    assertEqual(
      meta.signal_lifecycle_id,
      signalId,
      `events[${index}].meta.signal_lifecycle_id`,
    );
    assertEqual(
      meta.sequence,
      sequence,
      `events[${index}].meta.sequence`,
    );
    assertEqual(
      meta.event_type,
      type,
      `events[${index}].meta.event_type`,
    );
    assertEqual(
      meta.from_state,
      fromState,
      `events[${index}].meta.from_state`,
    );
    assertEqual(
      meta.to_state,
      toState,
      `events[${index}].meta.to_state`,
    );
    assertEqual(
      meta.occurred_at,
      occurredAt,
      `events[${index}].meta.occurred_at`,
    );

    timeline.push({
      eventId: id,
      signalId,
      sequence,
      eventType: type,
      fromState,
      toState,
      occurredAt,
      price: nullableDrDecimal(
        canonical.price,
        `events[${index}].canonical.price`,
      ),
      allocationFraction: nullableDrDecimal(
        canonical.allocationFraction,
        `events[${index}].canonical.allocationFraction`,
      ),
      reasonCodes: stringArray(
        canonical.reasonCodes,
        `events[${index}].canonical.reasonCodes`,
      ),
      sourceVersion: 1,
    });
  }

  if (timeline.length === 0) {
    fail("timeline must not be empty");
  }

  assertContract(
    state,
    "SignalLifecycleState",
    "stateSchemaVersion",
    "state",
  );
  assertEqual(
    state.signalLifecycleId,
    signalId,
    "state.signalLifecycleId",
  );

  const stateMarket = marketContext(
    state.marketContext,
    "state.marketContext",
  );
  assertEqual(
    stateMarket.exchange,
    exchange,
    "state.marketContext.exchange",
  );
  assertEqual(
    stateMarket.market,
    market,
    "state.marketContext.market",
  );
  assertEqual(
    stateMarket.symbol,
    symbol,
    "state.marketContext.symbol",
  );
  assertEqual(
    state.publishedAt,
    publishedAt,
    "state.publishedAt",
  );

  const lastEvent = timeline[timeline.length - 1];
  const stateSequence = integer(
    state.sequence,
    "state.sequence",
  );
  assertEqual(
    stateSequence,
    lastEvent.sequence,
    "state.sequence",
  );
  assertEqual(
    stateMeta.sequence,
    stateSequence,
    "stateMeta.sequence",
  );
  assertEqual(
    stateMeta.signal_lifecycle_id,
    signalId,
    "stateMeta.signal_lifecycle_id",
  );

  const currentState = lifecycleState(
    state.currentState,
    "state.currentState",
  );
  assertEqual(
    currentState,
    lastEvent.toState,
    "state.currentState",
  );
  assertEqual(
    stateMeta.current_state,
    currentState,
    "stateMeta.current_state",
  );

  const stateAsOf = timestamp(
    state.asOf,
    "state.asOf",
  );
  assertEqual(
    stateMeta.as_of,
    stateAsOf,
    "stateMeta.as_of",
  );

  const terminalAt = nullableString(
    state.terminalAt,
    "state.terminalAt",
  );
  if (terminalAt !== null) {
    timestamp(terminalAt, "state.terminalAt");
  }
  assertEqual(
    stateMeta.terminal_at,
    terminalAt,
    "stateMeta.terminal_at",
  );

  const entryEvent = timeline.find(
    (event) => event.eventType === "ENTRY_REACHED",
  );
  const stateEntryReachedAt = nullableString(
    state.entryReachedAt,
    "state.entryReachedAt",
  );

  let actualEntryPrice: string | null = null;
  if (entryEvent === undefined) {
    assertEqual(
      stateEntryReachedAt,
      null,
      "state.entryReachedAt before entry",
    );
  } else {
    assertEqual(
      stateEntryReachedAt,
      entryEvent.occurredAt,
      "state.entryReachedAt",
    );
    actualEntryPrice = string(
      entryEvent.price,
      "ENTRY_REACHED event price",
    );
    decimalString(
      actualEntryPrice,
      "ENTRY_REACHED event price",
    );
  }

  const reachedTargets = canonicalTargets(
    state.reachedTargets,
    "state.reachedTargets",
  );
  const eventReachedTargets =
    mappedEventTargets(timeline);

  if (
    !arraysEqual(
      reachedTargets,
      eventReachedTargets,
    )
  ) {
    fail("state.reachedTargets does not reconcile with timeline");
  }

  const snapshot: SignalSnapshot = {
    signalId,
    lifecycleState: currentState,
    entryReachedAt: stateEntryReachedAt,
    actualEntryPrice,
    reachedTargets,
    remainingAllocationFraction: drDecimal(
      state.remainingAllocationFraction,
      "state.remainingAllocationFraction",
    ),
    updatedAt: stateAsOf,
    terminalAt,
  };

  const outcomeMetaInput = input.outcomeMeta;
  const outcomeInput = input.outcome;

  let outcome: SignalOutcome | null = null;

  if (
    outcomeMetaInput === null ||
    outcomeInput === null
  ) {
    if (
      outcomeMetaInput !== null ||
      outcomeInput !== null
    ) {
      fail("outcome and outcomeMeta must both be null or both present");
    }
  } else {
    const outcomeMeta = record(
      outcomeMetaInput,
      "outcomeMeta",
    );
    const canonicalOutcome = record(
      outcomeInput,
      "outcome",
    );

    assertContract(
      canonicalOutcome,
      "SignalOutcome",
      "outcomeSchemaVersion",
      "outcome",
    );
    assertEqual(
      canonicalOutcome.signalLifecycleId,
      signalId,
      "outcome.signalLifecycleId",
    );
    assertEqual(
      outcomeMeta.signal_lifecycle_id,
      signalId,
      "outcomeMeta.signal_lifecycle_id",
    );
    assertEqual(
      outcomeMeta.lifecycle_revision,
      stateMeta.revision,
      "outcomeMeta.lifecycle_revision",
    );

    const finalStatus = string(
      canonicalOutcome.finalStatus,
      "outcome.finalStatus",
    );
    if (finalStatus !== "STOP" && finalStatus !== "TP3") {
      fail("outcome.finalStatus is not STOP or TP3");
    }

    const expectedTerminalState =
      finalStatus === "STOP"
        ? "STOP_REACHED"
        : "TP3_REACHED";

    assertEqual(
      currentState,
      expectedTerminalState,
      "terminal state/outcome",
    );
    assertEqual(
      outcomeMeta.final_status,
      finalStatus,
      "outcomeMeta.final_status",
    );

    const qualityStatus = string(
      canonicalOutcome.qualityStatus,
      "outcome.qualityStatus",
    );
    assertEqual(
      outcomeMeta.quality_status,
      qualityStatus,
      "outcomeMeta.quality_status",
    );

    const asOf = timestamp(
      canonicalOutcome.asOf,
      "outcome.asOf",
    );
    assertEqual(
      outcomeMeta.as_of,
      asOf,
      "outcomeMeta.as_of",
    );
    assertEqual(
      terminalAt,
      asOf,
      "outcome.asOf/state.terminalAt",
    );

    const outcomeEntry = record(
      canonicalOutcome.entry,
      "outcome.entry",
    );
    const entryReached = booleanValue(
      outcomeEntry.reached,
      "outcome.entry.reached",
    );
    const entryOccurredAt = nullableString(
      outcomeEntry.occurredAt,
      "outcome.entry.occurredAt",
    );
    const outcomeEntryPrice = nullableDrDecimal(
      outcomeEntry.price,
      "outcome.entry.price",
    );

    if (!entryReached) {
      fail("observed P3 terminal outcome without entry is unsupported");
    }

    assertEqual(
      entryOccurredAt,
      stateEntryReachedAt,
      "outcome.entry.occurredAt",
    );
    assertEqual(
      outcomeEntryPrice,
      actualEntryPrice,
      "outcome.entry.price",
    );

    const outcomeTargets = canonicalTargets(
      canonicalOutcome.reachedTargets,
      "outcome.reachedTargets",
    );
    if (!arraysEqual(outcomeTargets, reachedTargets)) {
      fail("outcome.reachedTargets does not match snapshot");
    }

    outcome = {
      signalId,
      finalStatus,
      qualityStatus,
      asOf,
      entry: {
        reached: true,
        occurredAt: entryOccurredAt,
        price: outcomeEntryPrice,
      },
      reachedTargets: outcomeTargets,
      underlyingReturn: drDecimal(
        canonicalOutcome.underlyingReturn,
        "outcome.underlyingReturn",
      ),
      modeledLeveragedReturn: drDecimal(
        canonicalOutcome.modeledLeveragedReturn,
        "outcome.modeledLeveragedReturn",
      ),
      netModeledReturn: drDecimal(
        canonicalOutcome.netModeledReturn,
        "outcome.netModeledReturn",
      ),
      mfe: drDecimal(
        canonicalOutcome.mfe,
        "outcome.mfe",
      ),
      mae: drDecimal(
        canonicalOutcome.mae,
        "outcome.mae",
      ),
      fees: drDecimal(
        canonicalOutcome.fees,
        "outcome.fees",
      ),
      slippage: drDecimal(
        canonicalOutcome.slippage,
        "outcome.slippage",
      ),
      funding: drDecimal(
        canonicalOutcome.funding,
        "outcome.funding",
      ),
      reasonCodes: stringArray(
        canonicalOutcome.reasonCodes,
        "outcome.reasonCodes",
      ),
    };
  }

  return Object.freeze({
    signalId,
    projection: Object.freeze(projection),
    timeline: Object.freeze(timeline),
    snapshot: Object.freeze(snapshot),
    outcome:
      outcome === null
        ? null
        : Object.freeze(outcome),
  });
}
