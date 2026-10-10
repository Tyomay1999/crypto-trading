import assert from "node:assert/strict";
import test from "node:test";

import {
  PostgresProjectionWriter,
  ProjectionPersistenceConflictError,
  asProjectionWriter,
} from "../dist/projection/postgres-writer.js";

class RecordingSqlClient {
  constructor(rowCounts = []) {
    this.calls = [];
    this.rowCounts = [...rowCounts];
  }

  async query(text, values = []) {
    this.calls.push({ text, values });
    return {
      rowCount:
        this.rowCounts.length === 0 ? 1 : this.rowCounts.shift(),
    };
  }
}

function projection(signalId = "signal-p7-unit") {
  return {
    signalId,
    exchange: "binance",
    market: "usdm_futures",
    symbol: "BTCUSDT",
    direction: "LONG",
    publishedAt: "2026-10-10T10:00:00.000Z",
    expiresAt: "2026-10-11T10:00:00.000Z",
    strategy: null,
    tradePlan: {
      entry: { referencePrice: "100.125", basis: "REFERENCE" },
      entryZone: { lower: "99.500", upper: "100.500", inclusive: true },
      stopLoss: { price: "95.000", reasonCode: null },
      takeProfits: [
        { label: "TP1", price: "105.250", allocationFraction: "0.4" },
        { label: "TP2", price: "110.375", allocationFraction: "0.3" },
        { label: "TP3", price: "115.500", allocationFraction: "0.3" },
      ],
    },
  };
}

function lifecycleEvent(signalId = "signal-p7-unit") {
  return {
    eventId: "event-3",
    signalId,
    sequence: 3,
    eventType: "ENTRY_REACHED",
    fromState: "WAITING_FOR_ENTRY",
    toState: "ENTRY_REACHED",
    occurredAt: "2026-10-10T10:01:00.000Z",
    price: "101.250",
    allocationFraction: null,
    reasonCodes: [],
    sourceVersion: 1,
  };
}

function snapshot(signalId = "signal-p7-unit") {
  return {
    signalId,
    lifecycleState: "TP1_REACHED",
    entryReachedAt: "2026-10-10T10:01:00.000Z",
    actualEntryPrice: "101.250",
    reachedTargets: ["TP1"],
    remainingAllocationFraction: "0.6",
    updatedAt: "2026-10-10T10:05:00.000Z",
    terminalAt: null,
  };
}

function outcome(signalId = "signal-p7-unit") {
  return {
    signalId,
    finalStatus: "STOP",
    qualityStatus: "COMPLETE",
    asOf: "2026-10-10T10:07:00.000Z",
    entry: {
      reached: true,
      occurredAt: "2026-10-10T10:01:00.000Z",
      price: "101.250",
    },
    reachedTargets: ["TP1"],
    underlyingReturn: "-0.03",
    modeledLeveragedReturn: "-0.03",
    netModeledReturn: "-0.0318",
    mfe: "0.05",
    mae: "-0.03",
    fees: "0.001",
    slippage: "0.0008",
    funding: "0",
    reasonCodes: [],
  };
}

test("PostgresProjectionWriter satisfies the ProjectionWriter boundary", () => {
  const writer = new PostgresProjectionWriter(new RecordingSqlClient());
  assert.equal(asProjectionWriter(writer), writer);
  assert.equal(typeof writer.publishSignal, "function");
  assert.equal(typeof writer.appendLifecycleEvent, "function");
  assert.equal(typeof writer.updateSnapshot, "function");
  assert.equal(typeof writer.writeOutcome, "function");
});

test("publishSignal stores P3 direct metadata plus the exact canonical JSON payload", async () => {
  const sql = new RecordingSqlClient();
  const writer = new PostgresProjectionWriter(sql);
  const payload = projection();
  await writer.publishSignal(payload.signalId, payload);

  const call = sql.calls[0];
  assert.match(call.text, /projection\.published_signals/);
  assert.equal(call.values[0], "signal-p7-unit");
  assert.equal(call.values[1], "dbdd0af64715596f705f3dff74f368fd1815dc26e22f326ddba10b400fa9dfa1");
  assert.deepEqual(call.values.slice(2, 6), ["binance", "usdm_futures", "BTCUSDT", "LONG"]);
  assert.equal(call.values[6], "2026-10-10T10:00:00.000Z");
  assert.equal(call.values[7], "2026-10-11T10:00:00.000Z");
  assert.deepEqual(JSON.parse(call.values[8]), payload);
  assert.equal("marketContext" in payload, false);
});

test("appendLifecycleEvent persists canonical event identity, sequence and occurredAt", async () => {
  const sql = new RecordingSqlClient();
  const writer = new PostgresProjectionWriter(sql);
  const event = lifecycleEvent();
  await writer.appendLifecycleEvent(event.signalId, event);

  const call = sql.calls[0];
  assert.match(call.text, /projection\.signal_events/);
  assert.deepEqual(call.values.slice(0, 6), [
    "signal-p7-unit", 3, "ENTRY_REACHED", "WAITING_FOR_ENTRY", "ENTRY_REACHED",
    "2026-10-10T10:01:00.000Z",
  ]);
  assert.deepEqual(JSON.parse(call.values[6]), event);
});

test("updateSnapshot derives persistence sequence from the immutable event frontier", async () => {
  const sql = new RecordingSqlClient();
  const writer = new PostgresProjectionWriter(sql);
  const payload = snapshot();
  await writer.updateSnapshot(payload.signalId, payload);

  const call = sql.calls[0];
  assert.match(call.text, /WITH event_frontier AS/);
  assert.match(call.text, /ORDER BY sequence DESC/);
  assert.match(call.text, /event_frontier\.to_state = \$2/);
  assert.match(call.text, /EXCLUDED\.sequence > projection\.signal_current\.sequence/);
  assert.deepEqual(call.values.slice(0, 4), [
    "signal-p7-unit", "TP1_REACHED", "2026-10-10T10:05:00.000Z", null,
  ]);
  assert.deepEqual(JSON.parse(call.values[4]), payload);
  assert.equal("sequence" in payload, false);
  assert.equal("asOf" in payload, false);
});

test("updateSnapshot fails closed when event frontier or canonical payload conflicts", async () => {
  const writer = new PostgresProjectionWriter(new RecordingSqlClient([0]));
  await assert.rejects(
    () => writer.updateSnapshot("signal-p7-unit", snapshot()),
    (error) =>
      error instanceof ProjectionPersistenceConflictError &&
      error.reason === "snapshot_event_frontier_or_payload_conflict",
  );
});

test("writeOutcome keeps canonical terminal outcome separate and duplicate persistence fail-closed", async () => {
  const successSql = new RecordingSqlClient([1]);
  const writer = new PostgresProjectionWriter(successSql);
  const payload = outcome();
  await writer.writeOutcome(payload.signalId, payload);

  const call = successSql.calls[0];
  assert.match(call.text, /projection\.signal_outcomes/);
  assert.deepEqual(call.values.slice(0, 3), [
    "signal-p7-unit", "STOP", "2026-10-10T10:07:00.000Z",
  ]);
  assert.deepEqual(JSON.parse(call.values[3]), payload);

  const rejectedWriter = new PostgresProjectionWriter(new RecordingSqlClient([0]));
  await assert.rejects(
    () => rejectedWriter.writeOutcome(payload.signalId, payload),
    ProjectionPersistenceConflictError,
  );
});

test("all writer operations reject canonical payload signalId mismatches before persistence", async () => {
  for (const invoke of [
    (writer) => writer.publishSignal("signal-a", projection("signal-b")),
    (writer) => writer.appendLifecycleEvent("signal-a", lifecycleEvent("signal-b")),
    (writer) => writer.updateSnapshot("signal-a", snapshot("signal-b")),
    (writer) => writer.writeOutcome("signal-a", outcome("signal-b")),
  ]) {
    const sql = new RecordingSqlClient();
    const writer = new PostgresProjectionWriter(sql);
    await assert.rejects(
      () => invoke(writer),
      (error) =>
        error instanceof ProjectionPersistenceConflictError &&
        error.reason === "signal_id_payload_signal_id_mismatch",
    );
    assert.equal(sql.calls.length, 0);
  }
});
