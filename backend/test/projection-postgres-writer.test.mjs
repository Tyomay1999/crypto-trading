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

test("PostgresProjectionWriter satisfies the ProjectionWriter boundary", () => {
  const writer = new PostgresProjectionWriter(
    new RecordingSqlClient(),
  );

  assert.equal(asProjectionWriter(writer), writer);
  assert.equal(typeof writer.publishSignal, "function");
  assert.equal(typeof writer.appendLifecycleEvent, "function");
  assert.equal(typeof writer.updateSnapshot, "function");
  assert.equal(typeof writer.writeOutcome, "function");
});

test("publishSignal stores queryable context plus the canonical JSON payload", async () => {
  const sql = new RecordingSqlClient();
  const writer = new PostgresProjectionWriter(sql);

  const payload = {
    id: "signal-p7-unit",
    marketContext: {
      exchange: "binance",
      market: "usdm_futures",
      symbol: "BTCUSDT",
    },
    direction: "LONG",
    expiresAt: "2026-10-11T10:00:00.000Z",
    lifecycle: {
      events: [
        {
          occurredAt: "2026-10-10T10:00:00.000Z",
        },
      ],
    },
    plannedEntry: "100.125",
  };

  await writer.publishSignal("signal-p7-unit", payload);

  assert.equal(sql.calls.length, 1);
  const call = sql.calls[0];

  assert.match(call.text, /projection\.published_signals/);
  assert.equal(call.values[0], "signal-p7-unit");
  assert.equal(
    call.values[1],
    "dbdd0af64715596f705f3dff74f368fd1815dc26e22f326ddba10b400fa9dfa1",
  );
  assert.deepEqual(call.values.slice(2, 6), [
    "binance",
    "usdm_futures",
    "BTCUSDT",
    "LONG",
  ]);
  assert.equal(call.values[6], "2026-10-10T10:00:00.000Z");
  assert.equal(call.values[7], "2026-10-11T10:00:00.000Z");
  assert.deepEqual(JSON.parse(call.values[8]), payload);
});

test("appendLifecycleEvent persists immutable signal sequence and occurredAt", async () => {
  const sql = new RecordingSqlClient();
  const writer = new PostgresProjectionWriter(sql);

  const event = {
    sequence: 3,
    eventType: "ENTRY_REACHED",
    fromState: "WAITING_FOR_ENTRY",
    toState: "ENTRY_REACHED",
    occurredAt: "2026-10-10T10:01:00.000Z",
    price: "101.250",
  };

  await writer.appendLifecycleEvent("signal-p7-unit", event);

  const call = sql.calls[0];
  assert.match(call.text, /projection\.signal_events/);
  assert.deepEqual(call.values.slice(0, 6), [
    "signal-p7-unit",
    3,
    "ENTRY_REACHED",
    "WAITING_FOR_ENTRY",
    "ENTRY_REACHED",
    "2026-10-10T10:01:00.000Z",
  ]);
  assert.deepEqual(JSON.parse(call.values[6]), event);
});

test("updateSnapshot uses guarded monotonic upsert semantics", async () => {
  const sql = new RecordingSqlClient();
  const writer = new PostgresProjectionWriter(sql);

  const snapshot = {
    currentState: "TP1_REACHED",
    sequence: 4,
    asOf: "2026-10-10T10:05:00.000Z",
    terminalAt: null,
    remainingAllocationFraction: "0.6",
  };

  await writer.updateSnapshot("signal-p7-unit", snapshot);

  const call = sql.calls[0];
  assert.match(call.text, /ON CONFLICT \(signal_id\)/);
  assert.match(
    call.text,
    /EXCLUDED\.sequence > projection\.signal_current\.sequence/,
  );
  assert.deepEqual(call.values.slice(0, 5), [
    "signal-p7-unit",
    "TP1_REACHED",
    4,
    "2026-10-10T10:05:00.000Z",
    null,
  ]);
  assert.deepEqual(JSON.parse(call.values[5]), snapshot);
});

test("updateSnapshot rejects a database no-op caused by stale or conflicting sequence", async () => {
  const sql = new RecordingSqlClient([0]);
  const writer = new PostgresProjectionWriter(sql);

  await assert.rejects(
    () =>
      writer.updateSnapshot("signal-p7-unit", {
        currentState: "ENTRY_REACHED",
        sequence: 3,
        asOf: "2026-10-10T10:01:00.000Z",
        terminalAt: null,
      }),
    (error) =>
      error instanceof ProjectionPersistenceConflictError &&
      error.reason === "snapshot_sequence_or_payload_conflict",
  );
});

test("writeOutcome keeps terminal outcome separate and duplicate persistence fail-closed", async () => {
  const successSql = new RecordingSqlClient([1]);
  const writer = new PostgresProjectionWriter(successSql);

  const outcome = {
    finalStatus: "STOP",
    asOf: "2026-10-10T10:07:00.000Z",
    netModeledReturn: "-0.0318",
  };

  await writer.writeOutcome("signal-p7-unit", outcome);

  const call = successSql.calls[0];
  assert.match(call.text, /projection\.signal_outcomes/);
  assert.deepEqual(call.values.slice(0, 3), [
    "signal-p7-unit",
    "STOP",
    "2026-10-10T10:07:00.000Z",
  ]);
  assert.deepEqual(JSON.parse(call.values[3]), outcome);

  const rejectedWriter = new PostgresProjectionWriter(
    new RecordingSqlClient([0]),
  );

  await assert.rejects(
    () => rejectedWriter.writeOutcome("signal-p7-unit", outcome),
    ProjectionPersistenceConflictError,
  );
});

test("publishSignal rejects a payload id that conflicts with authoritative signalId", async () => {
  const writer = new PostgresProjectionWriter(
    new RecordingSqlClient(),
  );

  await assert.rejects(
    () =>
      writer.publishSignal("signal-a", {
        id: "signal-b",
        marketContext: {
          exchange: "binance",
          market: "usdm_futures",
          symbol: "BTCUSDT",
        },
        direction: "LONG",
        publishedAt: "2026-10-10T10:00:00.000Z",
      }),
    (error) =>
      error instanceof ProjectionPersistenceConflictError &&
      error.reason === "signal_id_payload_id_mismatch",
  );
});
