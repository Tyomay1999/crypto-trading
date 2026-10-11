import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveSnapshotFromTimeline,
  projectionJsonEqual,
  reconcileProjectionBundle,
} from "../dist/aggregator/reconciler.js";

function clone(value) {
  return structuredClone(value);
}

function bundle() {
  const projection = {
    signalId: "signal-r",
    exchange: "binance",
    market: "usdm_futures",
    symbol: "ETHUSDT",
    direction: "LONG",
    publishedAt: "2026-10-10T10:00:00.000Z",
    expiresAt: "2026-10-11T10:00:00.000Z",
    strategy: {
      strategyId: "regime-trend-follow-v1",
      strategyVersion: "1.0.0",
    },
    tradePlan: {
      entry: {
        referencePrice: "100",
        basis: "MID_ZONE_REFERENCE",
      },
      entryZone: {
        lower: "99",
        upper: "101",
        inclusive: true,
      },
      stopLoss: {
        price: "90",
        reasonCode: "TEST",
      },
      takeProfits: [
        {
          label: "TP1",
          price: "110",
          allocationFraction: "0.4",
        },
        {
          label: "TP2",
          price: "120",
          allocationFraction: "0.3",
        },
        {
          label: "TP3",
          price: "130",
          allocationFraction: "0.3",
        },
      ],
    },
  };

  const timeline = [
    {
      eventId: "e1",
      signalId: "signal-r",
      sequence: 1,
      eventType: "SIGNAL_PUBLISHED",
      fromState: null,
      toState: "PUBLISHED",
      occurredAt: "2026-10-10T10:00:00.000Z",
      price: null,
      allocationFraction: null,
      reasonCodes: ["PUBLISHED"],
      sourceVersion: 1,
    },
    {
      eventId: "e2",
      signalId: "signal-r",
      sequence: 2,
      eventType: "WAITING_FOR_ENTRY",
      fromState: "PUBLISHED",
      toState: "WAITING_FOR_ENTRY",
      occurredAt: "2026-10-10T10:00:01.000Z",
      price: null,
      allocationFraction: null,
      reasonCodes: ["WAITING"],
      sourceVersion: 1,
    },
    {
      eventId: "e3",
      signalId: "signal-r",
      sequence: 3,
      eventType: "ENTRY_REACHED",
      fromState: "WAITING_FOR_ENTRY",
      toState: "ENTRY_REACHED",
      occurredAt: "2026-10-10T10:01:00.000Z",
      price: "100.25",
      allocationFraction: null,
      reasonCodes: ["ENTRY"],
      sourceVersion: 1,
    },
    {
      eventId: "e4",
      signalId: "signal-r",
      sequence: 4,
      eventType: "TP1_REACHED",
      fromState: "ENTRY_REACHED",
      toState: "TP1_REACHED",
      occurredAt: "2026-10-10T10:05:00.000Z",
      price: "110",
      allocationFraction: "0.4",
      reasonCodes: ["TP1"],
      sourceVersion: 1,
    },
  ];

  const snapshot =
    deriveSnapshotFromTimeline(
      projection,
      timeline,
    );

  return {
    signalId: "signal-r",
    projection,
    timeline,
    snapshot,
    outcome: null,
  };
}

class MemoryDestination {
  projection = null;
  events = [];
  current = null;
  outcome = null;

  writes = {
    publish: 0,
    event: 0,
    snapshot: 0,
    outcome: 0,
  };

  async listSignals() {
    return [];
  }

  async getSignal(signalId) {
    if (this.projection === null) return null;
    return {
      signalId,
      projection: clone(this.projection),
      current:
        this.current === null
          ? null
          : clone(this.current),
      outcome:
        this.outcome === null
          ? null
          : clone(this.outcome),
    };
  }

  async getEvents(signalId) {
    if (this.projection === null) return null;
    return {
      signalId,
      events: clone(this.events),
    };
  }

  async getOutcome(signalId) {
    if (this.projection === null) return null;
    return {
      signalId,
      outcome:
        this.outcome === null
          ? null
          : clone(this.outcome),
    };
  }

  async publishSignal(_signalId, projection) {
    if (this.projection !== null) {
      throw new Error("duplicate publish");
    }
    this.projection = clone(projection);
    this.writes.publish += 1;
  }

  async appendLifecycleEvent(_signalId, event) {
    if (this.events.length + 1 !== event.sequence) {
      throw new Error("event sequence conflict");
    }
    this.events.push(clone(event));
    this.writes.event += 1;
  }

  async updateSnapshot(_signalId, snapshot) {
    this.current = clone(snapshot);
    this.writes.snapshot += 1;
  }

  async writeOutcome(_signalId, outcome) {
    if (this.outcome !== null) {
      throw new Error("duplicate outcome");
    }
    this.outcome = clone(outcome);
    this.writes.outcome += 1;
  }
}

test("fresh destination receives publication, event timeline and snapshot", async () => {
  const source = bundle();
  const destination = new MemoryDestination();

  const result = await reconcileProjectionBundle(
    source,
    destination,
    destination,
  );

  assert.deepEqual(result, {
    published: true,
    eventsAppended: 4,
    snapshotUpdated: true,
    outcomeWritten: false,
  });
  assert.equal(
    projectionJsonEqual(
      destination.current,
      source.snapshot,
    ),
    true,
  );
});

test("exact replay is a zero-write no-op", async () => {
  const source = bundle();
  const destination = new MemoryDestination();

  await reconcileProjectionBundle(
    source,
    destination,
    destination,
  );

  destination.writes = {
    publish: 0,
    event: 0,
    snapshot: 0,
    outcome: 0,
  };

  const result = await reconcileProjectionBundle(
    source,
    destination,
    destination,
  );

  assert.deepEqual(result, {
    published: false,
    eventsAppended: 0,
    snapshotUpdated: false,
    outcomeWritten: false,
  });
  assert.deepEqual(destination.writes, {
    publish: 0,
    event: 0,
    snapshot: 0,
    outcome: 0,
  });
});

test("crash after event append but before snapshot is recovered by prefix reconciliation", async () => {
  const source = bundle();
  const destination = new MemoryDestination();

  destination.projection = clone(source.projection);
  destination.events = clone(source.timeline);
  destination.current =
    deriveSnapshotFromTimeline(
      source.projection,
      source.timeline.slice(0, 3),
    );

  const result = await reconcileProjectionBundle(
    source,
    destination,
    destination,
  );

  assert.equal(result.eventsAppended, 0);
  assert.equal(result.snapshotUpdated, true);
  assert.equal(
    projectionJsonEqual(
      destination.current,
      source.snapshot,
    ),
    true,
  );
});

test("terminal outcome can arrive later without rewriting timeline", async () => {
  const source = bundle();
  source.outcome = {
    signalId: "signal-r",
    finalStatus: "STOP",
    qualityStatus: "PASS",
    asOf: "2026-10-10T10:06:00.000Z",
    entry: {
      reached: true,
      occurredAt: "2026-10-10T10:01:00.000Z",
      price: "100.25",
    },
    reachedTargets: ["TP1"],
    underlyingReturn: "-0.01",
    modeledLeveragedReturn: "-0.03",
    netModeledReturn: "-0.0318",
    mfe: "0.02",
    mae: "-0.01",
    fees: "0.0012",
    slippage: "0.0006",
    funding: "0",
    reasonCodes: ["STOP_TERMINAL_OUTCOME"],
  };

  const destination = new MemoryDestination();
  destination.projection = clone(source.projection);
  destination.events = clone(source.timeline);
  destination.current = clone(source.snapshot);

  const result = await reconcileProjectionBundle(
    source,
    destination,
    destination,
  );

  assert.equal(result.outcomeWritten, true);
  assert.deepEqual(
    destination.outcome,
    source.outcome,
  );
});

test("destination divergence fails closed instead of overwriting global truth", async () => {
  const source = bundle();
  const destination = new MemoryDestination();

  destination.projection = {
    ...clone(source.projection),
    symbol: "BTCUSDT",
  };

  await assert.rejects(
    () =>
      reconcileProjectionBundle(
        source,
        destination,
        destination,
      ),
    /published projection differs/,
  );
});
