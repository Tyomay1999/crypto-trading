import assert from "node:assert/strict";
import test from "node:test";

import {
  mapDrBundleToP3,
} from "../dist/aggregator/dr-mapper.js";

function d(value) {
  return { $decimal: value };
}

function sourceBundle() {
  const signalId = "signal-real-shape-1";
  const planId = "plan-real-shape-1";

  const plan = {
    contractName: "PaperTradePlan",
    contractVersion: 1,
    planSchemaVersion: 1,
    paperTradePlanId: planId,
    direction: "SHORT",
    marketContext: {
      exchange: "binance",
      market: "usdm_futures",
      symbol: "ETHUSDT",
    },
    expiration: {
      expiresAt: "2026-10-09T12:45:00.000Z",
      reasonCode: "PLAN_TIME_WINDOW_EXPIRED",
    },
    entry: {
      basis: "MID_ZONE_REFERENCE",
      price: d("2531.61"),
    },
    entryZone: {
      lower: d("2529.07839"),
      upper: d("2534.14161"),
      inclusive: true,
    },
    stopLoss: {
      price: d("2556.9261"),
      reasonCode: "DETERMINISTIC_BPS_INVALIDATION",
    },
    takeProfits: [
      {
        label: "TP1",
        price: d("2506.2939"),
        allocationFraction: d("0.4"),
      },
      {
        label: "TP2",
        price: d("2480.9778"),
        allocationFraction: d("0.3"),
      },
      {
        label: "TP3",
        price: d("2455.6617"),
        allocationFraction: d("0.3"),
      },
    ],
    strategyLineage: [
      {
        strategyId: "regime-trend-follow-v1",
        strategyVersion: "1.0.0",
        configurationFingerprint: "must-not-project",
      },
    ],
    featureSnapshot: {
      featureSnapshotId: "must-not-project",
    },
    signalDecision: {
      deduplicationKey: "must-not-project",
    },
  };

  const rawEvents = [
    {
      id: "event-1",
      sequence: 1,
      eventType: "SIGNAL_PUBLISHED",
      fromState: null,
      toState: "PUBLISHED",
      occurredAt: "2026-10-08T12:45:00.000002Z",
      price: null,
      allocationFraction: null,
      reasonCodes: ["RISK_APPROVED_AND_PUBLICATION_ELIGIBLE"],
    },
    {
      id: "event-2",
      sequence: 2,
      eventType: "WAITING_FOR_ENTRY",
      fromState: "PUBLISHED",
      toState: "WAITING_FOR_ENTRY",
      occurredAt: "2026-10-08T12:45:00.000002Z",
      price: null,
      allocationFraction: null,
      reasonCodes: ["ENTRY_MONITORING_STARTED"],
    },
    {
      id: "event-3",
      sequence: 3,
      eventType: "ENTRY_REACHED",
      fromState: "WAITING_FOR_ENTRY",
      toState: "ENTRY_REACHED",
      occurredAt: "2026-10-08T12:45:04.846Z",
      price: d("2531.60"),
      allocationFraction: null,
      reasonCodes: ["ENTRY_ZONE_REACHED"],
    },
    {
      id: "event-4",
      sequence: 4,
      eventType: "TP1_REACHED",
      fromState: "ENTRY_REACHED",
      toState: "TP1_REACHED",
      occurredAt: "2026-10-08T13:42:38.839Z",
      price: d("2506.2939"),
      allocationFraction: d("0.4"),
      reasonCodes: ["TP1_PRICE_REACHED"],
    },
    {
      id: "event-5",
      sequence: 5,
      eventType: "TP2_REACHED",
      fromState: "TP1_REACHED",
      toState: "TP2_REACHED",
      occurredAt: "2026-10-08T15:20:42.263Z",
      price: d("2480.9778"),
      allocationFraction: d("0.3"),
      reasonCodes: ["TP2_PRICE_REACHED"],
    },
    {
      id: "event-6",
      sequence: 6,
      eventType: "TP3_REACHED",
      fromState: "TP2_REACHED",
      toState: "TP3_REACHED",
      occurredAt: "2026-10-08T15:23:24.783Z",
      price: d("2455.6617"),
      allocationFraction: d("0.3"),
      reasonCodes: ["TP3_PRICE_REACHED"],
    },
  ];

  const events = rawEvents.map((event) => ({
    meta: {
      signal_lifecycle_event_id: event.id,
      signal_lifecycle_id: signalId,
      sequence: event.sequence,
      event_type: event.eventType,
      from_state: event.fromState,
      to_state: event.toState,
      occurred_at: event.occurredAt,
    },
    canonical: {
      contractName: "SignalLifecycleEvent",
      contractVersion: 1,
      eventSchemaVersion: 1,
      signalLifecycleEventId: event.id,
      signalLifecycleId: signalId,
      sequence: event.sequence,
      eventType: event.eventType,
      fromState: event.fromState,
      toState: event.toState,
      occurredAt: event.occurredAt,
      price: event.price,
      allocationFraction: event.allocationFraction,
      reasonCodes: event.reasonCodes,
      marketObservationId: "must-not-project",
      riskAssessmentId: "must-not-project",
      paperTradePlanId: planId,
    },
  }));

  return {
    lifecycle: {
      signal_lifecycle_id: signalId,
      paper_trade_plan_id: planId,
      exchange: "binance",
      market: "usdm_futures",
      symbol: "ETHUSDT",
      published_at: "2026-10-08T12:45:00.000002Z",
    },
    planMeta: {
      paper_trade_plan_id: planId,
      exchange: "binance",
      market: "usdm_futures",
      symbol: "ETHUSDT",
      direction: "SHORT",
      expires_at: "2026-10-09T12:45:00.000Z",
    },
    plan,
    events,
    stateMeta: {
      signal_lifecycle_id: signalId,
      revision: 5,
      sequence: 6,
      current_state: "TP3_REACHED",
      as_of: "2026-10-08T15:23:24.783Z",
      terminal_at: "2026-10-08T15:23:24.783Z",
    },
    state: {
      contractName: "SignalLifecycleState",
      contractVersion: 1,
      stateSchemaVersion: 1,
      signalLifecycleId: signalId,
      currentState: "TP3_REACHED",
      sequence: 6,
      asOf: "2026-10-08T15:23:24.783Z",
      entryReachedAt: "2026-10-08T12:45:04.846Z",
      reachedTargets: ["TP1", "TP2", "TP3"],
      remainingAllocationFraction: d("0"),
      terminalAt: "2026-10-08T15:23:24.783Z",
      publishedAt: "2026-10-08T12:45:00.000002Z",
      marketContext: {
        exchange: "binance",
        market: "usdm_futures",
        symbol: "ETHUSDT",
      },
      lastObservationId: "must-not-project",
      paperTradePlanId: planId,
      riskAssessmentId: "must-not-project",
    },
    outcomeMeta: {
      signal_outcome_id: "outcome-internal-id",
      signal_lifecycle_id: signalId,
      lifecycle_revision: 5,
      as_of: "2026-10-08T15:23:24.783Z",
      final_status: "TP3",
      quality_status: "PASS",
    },
    outcome: {
      contractName: "SignalOutcome",
      contractVersion: 1,
      outcomeSchemaVersion: 1,
      signalLifecycleId: signalId,
      signalOutcomeId: "must-not-project",
      finalStatus: "TP3",
      qualityStatus: "PASS",
      asOf: "2026-10-08T15:23:24.783Z",
      entry: {
        reached: true,
        occurredAt: "2026-10-08T12:45:04.846Z",
        price: d("2531.60"),
      },
      reachedTargets: ["TP1", "TP2", "TP3"],
      underlyingReturn: d("0.01899612498"),
      modeledLeveragedReturn: d("0.05698837494"),
      netModeledReturn: d("0.05518837494"),
      mfe: d("0.030028440512"),
      mae: d("-0.003819718755"),
      fees: d("0.0012"),
      slippage: d("0.0006"),
      funding: d("0"),
      reasonCodes: [
        "ENTRY_REFERENCE_APPLIED",
        "TP3_TERMINAL_OUTCOME",
      ],
      configurationFingerprint: "must-not-project",
      paperTradePlanId: planId,
      riskAssessmentId: "must-not-project",
    },
  };
}

test("DR mapper emits exact P3 surface and preserves planned vs actual entry", () => {
  const mapped = mapDrBundleToP3(sourceBundle());

  assert.equal(mapped.signalId, "signal-real-shape-1");
  assert.equal(
    mapped.projection.tradePlan.entry.referencePrice,
    "2531.61",
  );
  assert.equal(
    mapped.snapshot.actualEntryPrice,
    "2531.60",
  );
  assert.notEqual(
    mapped.projection.tradePlan.entry.referencePrice,
    mapped.snapshot.actualEntryPrice,
  );

  assert.deepEqual(
    mapped.projection.strategy,
    {
      strategyId: "regime-trend-follow-v1",
      strategyVersion: "1.0.0",
    },
  );

  assert.deepEqual(
    mapped.projection.tradePlan.takeProfits.map(
      ({ label, allocationFraction }) => ({
        label,
        allocationFraction,
      }),
    ),
    [
      { label: "TP1", allocationFraction: "0.4" },
      { label: "TP2", allocationFraction: "0.3" },
      { label: "TP3", allocationFraction: "0.3" },
    ],
  );

  assert.equal(mapped.timeline[0].sourceVersion, 1);
  assert.equal(mapped.timeline[5].sequence, 6);
  assert.equal(mapped.snapshot.remainingAllocationFraction, "0");
  assert.equal(mapped.outcome.finalStatus, "TP3");

  const projected = JSON.stringify(mapped);
  for (const forbidden of [
    "riskAssessmentId",
    "paperTradePlanId",
    "marketObservationId",
    "configurationFingerprint",
    "featureSnapshotId",
    "deduplicationKey",
    "signalOutcomeId",
  ]) {
    assert.equal(
      projected.includes(forbidden),
      false,
      `forbidden DR field leaked: ${forbidden}`,
    );
  }
});

test("DR mapper fails closed on non-contiguous source sequence", () => {
  const input = sourceBundle();
  input.events[3].canonical.sequence = 9;

  assert.throws(
    () => mapDrBundleToP3(input),
    /event sequence must be contiguous/,
  );
});

test("DR mapper fails closed on market-context drift", () => {
  const input = sourceBundle();
  input.plan.marketContext.symbol = "BTCUSDT";

  assert.throws(
    () => mapDrBundleToP3(input),
    /marketContext\.symbol mismatch/,
  );
});

test("DR mapper requires observed event schema version 1", () => {
  const input = sourceBundle();
  input.events[0].canonical.eventSchemaVersion = 2;

  assert.throws(
    () => mapDrBundleToP3(input),
    /eventSchemaVersion mismatch/,
  );
});
