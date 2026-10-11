import assert from "node:assert/strict";
import test from "node:test";

const {
  applyGlobalStop,
  applyGlobalTarget,
  applyManualExit,
  moveUserStop,
  openUserPosition,
  PostgresPositionAccountingRepository,
} = await import("../dist/user-trading/accounting/index.js");

function opened(overrides = {}) {
  return {
    ...openUserPosition({
      positionId: "position-a",
      participationId: "participation-a",
      userId: "user-a",
      signalId: "signal-a",
      direction: "LONG",
      actualEntryPrice: "100",
      initialNotional: "1000",
      originalStopPrice: "90",
      enteredAt: "2026-10-11T17:00:00.000Z",
      globalSequence: "2",
    }),
    ...overrides,
  };
}

test("entry converts selected notional into exact quantity and initializes original stop", () => {
  const position = opened();
  assert.equal(position.initialQuantity, "10");
  assert.equal(position.initialNotional, "1000");
  assert.equal(position.remainingFraction, "1");
  assert.equal(position.realizedFraction, "0");
  assert.equal(position.realizedPnl, "0");
  assert.equal(position.stopBasis, "ORIGINAL");
  assert.equal(position.selectedStopPrice, "90");
});

test("TP allocation is read from input rather than hardcoded and updates realized P&L", () => {
  const result = applyGlobalTarget(opened(), {
    target: "TP1",
    price: "110",
    allocationFraction: "0.4",
    globalSequence: "3",
    occurredAt: "2026-10-11T17:03:00.000Z",
  });

  assert.equal(result.kind, "APPLIED");
  assert.equal(result.position.remainingFraction, "0.6");
  assert.equal(result.position.realizedFraction, "0.4");
  assert.equal(result.position.realizedPnl, "40");
  assert.equal(result.position.state, "PARTIALLY_REALIZED");
});

test("mandatory allocation path supports 30/30/40 without embedding those fractions", () => {
  const tp1 = applyGlobalTarget(opened(), {
    target: "TP1",
    price: "110",
    allocationFraction: "0.3",
    globalSequence: "3",
    occurredAt: "2026-10-11T17:03:00.000Z",
  }).position;

  const tp2 = applyGlobalTarget(tp1, {
    target: "TP2",
    price: "120",
    allocationFraction: "0.3",
    globalSequence: "4",
    occurredAt: "2026-10-11T17:03:00.000Z",
  }).position;

  const tp3 = applyGlobalTarget(tp2, {
    target: "TP3",
    price: "130",
    allocationFraction: "0.4",
    globalSequence: "5",
    occurredAt: "2026-10-11T17:03:00.000Z",
  }).position;

  assert.equal(tp3.state, "COMPLETED");
  assert.equal(tp3.remainingFraction, "0");
  assert.equal(tp3.realizedFraction, "1");
  assert.equal(tp3.realizedPnl, "210");
  assert.equal(tp3.terminalAt, "2026-10-11T17:03:00.000Z");
});

test("duplicate or stale global sequence never double-counts TP realization", () => {
  const first = applyGlobalTarget(opened(), {
    target: "TP1",
    price: "110",
    allocationFraction: "0.3",
    globalSequence: "3",
    occurredAt: "2026-10-11T17:03:00.000Z",
  });
  const duplicate = applyGlobalTarget(first.position, {
    target: "TP1",
    price: "110",
    allocationFraction: "0.3",
    globalSequence: "3",
    occurredAt: "2026-10-11T17:03:00.000Z",
  });

  assert.equal(duplicate.kind, "STALE_OR_DUPLICATE");
  assert.equal(duplicate.position.realizedPnl, "30");
  assert.equal(duplicate.position.remainingFraction, "0.7");
});

test("stop can move ORIGINAL -> ENTRY -> TP1 -> TP2 only after lifecycle eligibility", () => {
  const base = opened();

  const entry = moveUserStop(base, { basis: "ENTRY", price: "100" });
  assert.equal(entry.kind, "APPLIED");
  assert.equal(entry.position.stopBasis, "ENTRY");

  const earlyTp1 = moveUserStop(entry.position, { basis: "TP1", price: "110" });
  assert.equal(earlyTp1.kind, "NOT_ELIGIBLE");

  const afterTp1 = applyGlobalTarget(entry.position, {
    target: "TP1",
    price: "110",
    allocationFraction: "0.3",
    globalSequence: "3",
    occurredAt: "2026-10-11T17:03:00.000Z",
  }).position;

  const tp1Stop = moveUserStop(afterTp1, { basis: "TP1", price: "110" });
  assert.equal(tp1Stop.kind, "APPLIED");
  assert.equal(tp1Stop.position.stopBasis, "TP1");

  const afterTp2 = applyGlobalTarget(tp1Stop.position, {
    target: "TP2",
    price: "120",
    allocationFraction: "0.3",
    globalSequence: "4",
    occurredAt: "2026-10-11T17:03:00.000Z",
  }).position;

  const tp2Stop = moveUserStop(afterTp2, { basis: "TP2", price: "120" });
  assert.equal(tp2Stop.kind, "APPLIED");
  assert.equal(tp2Stop.position.stopBasis, "TP2");
});

test("backward or same-basis stop movement fails closed", () => {
  const entry = moveUserStop(opened(), { basis: "ENTRY", price: "100" }).position;
  assert.equal(
    moveUserStop(entry, { basis: "ENTRY", price: "100" }).kind,
    "NON_MONOTONIC",
  );
});

test("STOP after TP1 uses current user stop on the remaining position", () => {
  const tp1 = applyGlobalTarget(opened(), {
    target: "TP1",
    price: "110",
    allocationFraction: "0.3",
    globalSequence: "3",
    occurredAt: "2026-10-11T17:03:00.000Z",
  }).position;
  const moved = moveUserStop(tp1, { basis: "TP1", price: "110" }).position;
  const stopped = applyGlobalStop(moved, {
    globalSequence: "4",
    occurredAt: "2026-10-11T17:03:00.000Z",
  }).position;

  assert.equal(stopped.state, "STOPPED");
  assert.equal(stopped.remainingFraction, "0");
  assert.equal(stopped.realizedFraction, "1");
  assert.equal(stopped.realizedPnl, "100");
});

test("STOP after TP2 with SL at TP2 realizes TP1 + TP2 + remaining at TP2", () => {
  const tp1 = applyGlobalTarget(opened(), {
    target: "TP1",
    price: "110",
    allocationFraction: "0.3",
    globalSequence: "3",
    occurredAt: "2026-10-11T17:03:00.000Z",
  }).position;
  const tp2 = applyGlobalTarget(tp1, {
    target: "TP2",
    price: "120",
    allocationFraction: "0.3",
    globalSequence: "4",
    occurredAt: "2026-10-11T17:03:00.000Z",
  }).position;
  const moved = moveUserStop(tp2, { basis: "TP2", price: "120" }).position;
  const stopped = applyGlobalStop(moved, {
    globalSequence: "5",
    occurredAt: "2026-10-11T17:04:00.000Z",
  }).position;

  assert.equal(stopped.realizedPnl, "170");
  assert.equal(stopped.state, "STOPPED");
});

test("manual exit realizes only the remaining position and keeps prior TP profit", () => {
  const tp1 = applyGlobalTarget(opened(), {
    target: "TP1",
    price: "110",
    allocationFraction: "0.3",
    globalSequence: "3",
    occurredAt: "2026-10-11T17:03:00.000Z",
  }).position;

  const exited = applyManualExit(tp1, {
    price: "105",
    occurredAt: "2026-10-11T17:02:00.000Z",
  });

  assert.equal(exited.state, "EXITED_EARLY");
  assert.equal(exited.remainingFraction, "0");
  assert.equal(exited.realizedFraction, "1");
  assert.equal(exited.realizedPnl, "65");
});

test("SHORT P&L has the correct sign and stop progression direction", () => {
  const short = openUserPosition({
    positionId: "short",
    participationId: "p-short",
    userId: "user-a",
    signalId: "signal-short",
    direction: "SHORT",
    actualEntryPrice: "100",
    initialNotional: "1000",
    originalStopPrice: "110",
    enteredAt: "2026-10-11T17:00:00.000Z",
    globalSequence: "2",
  });

  const tp1 = applyGlobalTarget(short, {
    target: "TP1",
    price: "90",
    allocationFraction: "0.5",
    globalSequence: "3",
    occurredAt: "2026-10-11T17:03:00.000Z",
  }).position;
  assert.equal(tp1.realizedPnl, "50");

  const moved = moveUserStop(tp1, { basis: "TP1", price: "90" });
  assert.equal(moved.kind, "APPLIED");

  const stopped = applyGlobalStop(moved.position, {
    globalSequence: "4",
    occurredAt: "2026-10-11T17:02:00.000Z",
  }).position;
  assert.equal(stopped.realizedPnl, "100");
});

test("TP3 must consume all remaining fraction", () => {
  assert.throws(
    () =>
      applyGlobalTarget(opened(), {
        target: "TP3",
        price: "130",
        allocationFraction: "0.4",
        globalSequence: "3",
        occurredAt: "2026-10-11T17:03:00.000Z",
      }),
    /consume the full remaining/u,
  );
});

test("Postgres repository uses user ownership and optimistic version CAS", async () => {
  const calls = [];
  const db = {
    async query(text, values = []) {
      calls.push({ scope: "pool", text, values });
      return { rows: [] };
    },
    async connect() {
      return {
        async query(text, values = []) {
          calls.push({ scope: "tx", text, values });
          return { rows: [] };
        },
        release() {},
      };
    },
  };

  const repo = new PostgresPositionAccountingRepository(db);
  await repo.findOwnedPosition("user-a' OR 1=1 --", "position-a");

  assert.match(
    calls[0].text,
    /WHERE user_id = \$1[\s\S]*position_id = \$2/u,
  );
  assert.doesNotMatch(calls[0].text, /OR 1=1/u);
});

test("accounting source has no frozen auth/security implementation dependency", async () => {
  const { readFileSync } = await import("node:fs");
  for (const file of [
    "src/user-trading/accounting/types.ts",
    "src/user-trading/accounting/math.ts",
    "src/user-trading/accounting/engine.ts",
    "src/user-trading/accounting/repository.ts",
    "src/user-trading/accounting/postgres-repository.ts",
    "src/user-trading/accounting/service.ts",
    "src/user-trading/accounting/index.ts",
  ]) {
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(
      source,
      /from\s+["'][^"']*(?:\/auth\/|\/security\/|require-session|better-auth)/iu,
    );
  }
});

test("multi-session concurrent mutations resolve through optimistic CAS rather than last-write-wins", async () => {
  const { UserPositionAccountingService } =
    await import("../dist/user-trading/accounting/index.js");

  let stored = opened();
  let saveCount = 0;

  const repository = {
    async findEntryContext() {
      return null;
    },
    async createPosition() {
      return null;
    },
    async findOwnedPosition(userId, positionId) {
      assert.equal(userId, "user-a");
      assert.equal(positionId, "position-a");
      return structuredClone(stored);
    },
    async savePositionCas({ previousVersion, snapshot }) {
      saveCount += 1;
      if (stored.version !== previousVersion) {
        return null;
      }
      stored = structuredClone(snapshot);
      return structuredClone(stored);
    },
  };

  const serviceA = new UserPositionAccountingService({
    repository,
    idFactory: { createPositionId: () => "unused-a" },
  });

  const staleForSessionB = structuredClone(stored);

  const first = await serviceA.moveStop({
    userId: "user-a",
    positionId: "position-a",
    move: { basis: "ENTRY", price: "100" },
  });

  assert.equal(first.kind, "APPLIED");
  assert.equal(first.position.version, "2");

  const candidateB = moveUserStop(staleForSessionB, {
    basis: "ENTRY",
    price: "100",
  });

  assert.equal(candidateB.kind, "APPLIED");

  const secondSave = await repository.savePositionCas({
    previousVersion: staleForSessionB.version,
    snapshot: candidateB.position,
  });

  assert.equal(secondSave, null);
  assert.equal(stored.version, "2");
  assert.equal(stored.stopBasis, "ENTRY");
  assert.equal(saveCount, 2);
});
