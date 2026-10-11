import assert from "node:assert/strict";
import test from "node:test";

const {
  buildTerminalOutcome,
  PostgresUserTradingLedgerRepository,
  UserTradingLedgerService,
} = await import("../dist/user-trading/ledger/index.js");

function position(overrides = {}) {
  return {
    positionId: "position-a",
    participationId: "participation-a",
    userId: "user-a",
    signalId: "signal-a",
    direction: "LONG",
    state: "OPEN",
    actualEntryPrice: "100",
    enteredAt: "2026-10-11T17:00:00.000Z",
    initialQuantity: "10",
    initialNotional: "1000",
    remainingFraction: "1",
    realizedFraction: "0",
    realizedPnl: "0",
    selectedStopPrice: "90",
    stopBasis: "ORIGINAL",
    lastGlobalSequence: "2",
    lastGlobalState: "ENTRY_REACHED",
    version: "1",
    terminalAt: null,
    ...overrides,
  };
}

function event(id = "evt-idem") {
  return {
    eventId: "event-1",
    positionId: "position-a",
    participationId: "participation-a",
    userId: "user-a",
    signalId: "signal-a",
    eventType: "STOP_MOVED_TO_ENTRY",
    eventIdentity: id,
    globalEventIdentity: null,
    globalSequence: null,
    occurredAt: "2026-10-11T17:01:00.000Z",
    observedAt: "2026-10-11T17:01:00.000Z",
    payload: { basis: "ENTRY", price: "100" },
    createdAt: "2026-10-11T17:01:00.000Z",
  };
}

function outcome(overrides = {}) {
  return {
    positionId: "position-a",
    participationId: "participation-a",
    userId: "user-a",
    signalId: "signal-a",
    terminalReason: "MANUAL_EXIT",
    userTerminalState: "EXITED_EARLY",
    actualExitPrice: "105",
    realizedPnl: "50",
    realizedReturn: "0.05",
    realizedFraction: "1",
    fees: "0",
    completedAt: "2026-10-11T17:05:00.000Z",
    ...overrides,
  };
}

test("terminal outcome derives exact realized return from authoritative notional", () => {
  const built = buildTerminalOutcome(
    position({
      state: "EXITED_EARLY",
      remainingFraction: "0",
      realizedFraction: "1",
      realizedPnl: "65",
      terminalAt: "2026-10-11T17:05:00.000Z",
    }),
    {
      terminalReason: "MANUAL_EXIT",
      actualExitPrice: "105",
      completedAt: "2026-10-11T17:05:00.000Z",
    },
  );

  assert.equal(built.realizedPnl, "65");
  assert.equal(built.realizedReturn, "0.065");
  assert.equal(built.realizedFraction, "1");
  assert.equal(built.terminalReason, "MANUAL_EXIT");
});

test("same multi-device event identity is idempotent before accounting runs again", async () => {
  let engineVisiblePosition = position({
    selectedStopPrice: "100",
    stopBasis: "ENTRY",
    version: "2",
  });
  let findCount = 0;
  const existing = event("device-shared-id");

  const repository = {
    async findEventByIdentity(userId, positionId, identity) {
      assert.equal(userId, "user-a");
      assert.equal(positionId, "position-a");
      assert.equal(identity, "device-shared-id");
      return { event: existing, outcome: null };
    },
    async findOwnedPosition() {
      findCount += 1;
      return structuredClone(engineVisiblePosition);
    },
    async commitMutation() {
      throw new Error("duplicate must not mutate");
    },
    async appendObservation() {
      throw new Error("unused");
    },
  };

  const service = new UserTradingLedgerService({
    repository,
    idFactory: { createEventId: () => "unused" },
  });

  const replay = await service.moveStop({
    userId: "user-a",
    positionId: "position-a",
    eventIdentity: "device-shared-id",
    observedAt: "2026-10-11T17:01:01.000Z",
    move: { basis: "ENTRY", price: "100" },
  });

  assert.equal(replay.kind, "IDEMPOTENT_REPLAY");
  assert.equal(replay.event.eventIdentity, "device-shared-id");
  assert.equal(findCount, 1);
});

test("different concurrent device actions remain distinct and rely on version conflict", async () => {
  const base = position();
  let stored = structuredClone(base);
  let committedEvent = null;

  const repository = {
    async findEventByIdentity(_userId, _positionId, identity) {
      return committedEvent?.eventIdentity === identity
        ? { event: committedEvent, outcome: null }
        : null;
    },
    async findOwnedPosition() {
      return structuredClone(stored);
    },
    async commitMutation(input) {
      if (input.expectedVersion !== stored.version) {
        return { kind: "CONCURRENT_CONFLICT" };
      }
      stored = structuredClone(input.nextPosition);
      committedEvent = {
        ...event(input.event.eventIdentity),
        eventId: input.event.eventId,
        eventType: input.event.eventType,
        payload: input.event.payload,
      };
      return {
        kind: "APPLIED",
        position: structuredClone(stored),
        event: structuredClone(committedEvent),
        outcome: null,
      };
    },
    async appendObservation() {
      throw new Error("unused");
    },
  };

  let id = 0;
  const a = new UserTradingLedgerService({
    repository,
    idFactory: { createEventId: () => `event-${++id}` },
  });

  const stale = structuredClone(base);

  const first = await a.moveStop({
    userId: "user-a",
    positionId: "position-a",
    eventIdentity: "iphone-move-entry",
    observedAt: "2026-10-11T17:01:00.000Z",
    move: { basis: "ENTRY", price: "100" },
  });

  assert.equal(first.kind, "APPLIED");

  const staleCandidate = {
    ...stale,
    selectedStopPrice: "100",
    stopBasis: "ENTRY",
    version: "2",
  };

  const second = await repository.commitMutation({
    userId: "user-a",
    expectedVersion: stale.version,
    nextPosition: staleCandidate,
    event: {
      eventId: "event-web",
      eventType: "STOP_MOVED_TO_ENTRY",
      eventIdentity: "web-move-entry",
      globalEventIdentity: null,
      globalSequence: null,
      occurredAt: "2026-10-11T17:01:00.000Z",
      observedAt: "2026-10-11T17:01:00.000Z",
      payload: {},
    },
    terminalOutcome: null,
  });

  assert.equal(second.kind, "CONCURRENT_CONFLICT");
  assert.equal(stored.version, "2");
});

test("early user exit outcome stays immutable when global outcome arrives later", async () => {
  const exited = position({
    state: "EXITED_EARLY",
    remainingFraction: "0",
    realizedFraction: "1",
    realizedPnl: "65",
    terminalAt: "2026-10-11T17:05:00.000Z",
    version: "3",
  });
  const savedOutcome = outcome({ realizedPnl: "65", realizedReturn: "0.065" });
  const events = [];

  const repository = {
    async findEventByIdentity() {
      return null;
    },
    async findOwnedPosition() {
      return structuredClone(exited);
    },
    async commitMutation() {
      throw new Error("global observation must not rewrite position/outcome");
    },
    async appendObservation(input) {
      events.push(input.event);
      return {
        kind: "APPLIED",
        position: structuredClone(exited),
        event: {
          ...event(input.event.eventIdentity),
          eventId: input.event.eventId,
          eventType: input.event.eventType,
          globalEventIdentity: input.event.globalEventIdentity,
          globalSequence: input.event.globalSequence,
          payload: input.event.payload,
        },
        outcome: structuredClone(savedOutcome),
      };
    },
  };

  const service = new UserTradingLedgerService({
    repository,
    idFactory: { createEventId: () => "event-global-outcome" },
  });

  const result = await service.observeGlobalOutcome({
    userId: "user-a",
    positionId: "position-a",
    eventIdentity: "global-outcome:signal-a:5",
    globalEventIdentity: "signal-a:5",
    globalSequence: "5",
    occurredAt: "2026-10-11T17:10:00.000Z",
    observedAt: "2026-10-11T17:10:01.000Z",
    globalTerminalStatus: "TP3",
  });

  assert.equal(result.kind, "APPLIED");
  assert.equal(result.position.state, "EXITED_EARLY");
  assert.equal(result.outcome.realizedPnl, "65");
  assert.equal(result.outcome.realizedReturn, "0.065");
  assert.equal(events[0].eventType, "GLOBAL_OUTCOME_OBSERVED");
  assert.deepEqual(events[0].payload, { globalTerminalStatus: "TP3" });
});

test("TP3 mutation writes terminal outcome while TP1 writes ledger only", async () => {
  let current = position();
  const commits = [];

  const repository = {
    async findEventByIdentity() {
      return null;
    },
    async findOwnedPosition() {
      return structuredClone(current);
    },
    async commitMutation(input) {
      commits.push(input);
      current = structuredClone(input.nextPosition);
      return {
        kind: "APPLIED",
        position: structuredClone(current),
        event: {
          ...event(input.event.eventIdentity),
          eventId: input.event.eventId,
          eventType: input.event.eventType,
          globalEventIdentity: input.event.globalEventIdentity,
          globalSequence: input.event.globalSequence,
          payload: input.event.payload,
        },
        outcome:
          input.terminalOutcome === null
            ? null
            : outcome({
                terminalReason: input.terminalOutcome.terminalReason,
                userTerminalState: current.state,
                realizedPnl: current.realizedPnl,
              }),
      };
    },
    async appendObservation() {
      throw new Error("unused");
    },
  };

  let n = 0;
  const service = new UserTradingLedgerService({
    repository,
    idFactory: { createEventId: () => `event-${++n}` },
  });

  const tp1 = await service.applyTarget({
    userId: "user-a",
    positionId: "position-a",
    eventIdentity: "global:3",
    globalEventIdentity: "signal-a:3",
    observedAt: "2026-10-11T17:01:01.000Z",
    target: {
      target: "TP1",
      price: "110",
      allocationFraction: "0.3",
      globalSequence: "3",
      occurredAt: "2026-10-11T17:01:00.000Z",
    },
  });

  assert.equal(tp1.kind, "APPLIED");
  assert.equal(commits[0].terminalOutcome, null);
  assert.equal(commits[0].event.eventType, "TP_REALIZED");

  await service.applyTarget({
    userId: "user-a",
    positionId: "position-a",
    eventIdentity: "global:4",
    globalEventIdentity: "signal-a:4",
    observedAt: "2026-10-11T17:02:01.000Z",
    target: {
      target: "TP2",
      price: "120",
      allocationFraction: "0.3",
      globalSequence: "4",
      occurredAt: "2026-10-11T17:02:00.000Z",
    },
  });

  const tp3 = await service.applyTarget({
    userId: "user-a",
    positionId: "position-a",
    eventIdentity: "global:5",
    globalEventIdentity: "signal-a:5",
    observedAt: "2026-10-11T17:03:01.000Z",
    target: {
      target: "TP3",
      price: "130",
      allocationFraction: "0.4",
      globalSequence: "5",
      occurredAt: "2026-10-11T17:03:00.000Z",
    },
  });

  assert.equal(tp3.kind, "APPLIED");
  assert.equal(commits[2].event.eventType, "POSITION_COMPLETED");
  assert.equal(commits[2].terminalOutcome.terminalReason, "TP3");
});

test("manual exit creates one terminal immutable outcome", async () => {
  let current = position();
  let terminalDraft = null;

  const repository = {
    async findEventByIdentity() {
      return null;
    },
    async findOwnedPosition() {
      return structuredClone(current);
    },
    async commitMutation(input) {
      terminalDraft = input.terminalOutcome;
      current = structuredClone(input.nextPosition);
      return {
        kind: "APPLIED",
        position: current,
        event: event(input.event.eventIdentity),
        outcome: outcome(),
      };
    },
    async appendObservation() {
      throw new Error("unused");
    },
  };

  const service = new UserTradingLedgerService({
    repository,
    idFactory: { createEventId: () => "event-exit" },
  });

  const result = await service.manualExit({
    userId: "user-a",
    positionId: "position-a",
    eventIdentity: "iphone-manual-exit-1",
    observedAt: "2026-10-11T17:05:01.000Z",
    exit: {
      price: "105",
      occurredAt: "2026-10-11T17:05:00.000Z",
    },
  });

  assert.equal(result.kind, "APPLIED");
  assert.equal(terminalDraft.terminalReason, "MANUAL_EXIT");
  assert.equal(terminalDraft.actualExitPrice, "105");
});

test("Postgres ledger repository serializes position, event and outcome in one transaction", async () => {
  const calls = [];
  const db = {
    async query() {
      return { rows: [] };
    },
    async connect() {
      return {
        async query(text, values = []) {
          calls.push({ text, values });
          if (/SELECT[\s\S]+FROM app\.user_position[\s\S]+FOR UPDATE/u.test(text)) {
            return {
              rows: [{
                position_id: "position-a",
                participation_id: "participation-a",
                user_id: "user-a",
                signal_id: "signal-a",
                direction: "LONG",
                state: "OPEN",
                actual_entry_price: "100",
                entered_at: new Date("2026-10-11T17:00:00.000Z"),
                initial_quantity: "10",
                initial_notional: "1000",
                remaining_fraction: "1",
                realized_fraction: "0",
                realized_pnl: "0",
                selected_stop_price: "90",
                stop_basis: "ORIGINAL",
                last_global_sequence: "2",
                last_global_state: "ENTRY_REACHED",
                version: "1",
                terminal_at: null,
              }],
            };
          }
          if (/FROM app\.user_position_event/u.test(text)) return { rows: [] };
          if (/UPDATE app\.user_position/u.test(text)) return { rows: [] };
          return { rows: [] };
        },
        release() {},
      };
    },
  };

  const repo = new PostgresUserTradingLedgerRepository(db);
  const result = await repo.commitMutation({
    userId: "user-a",
    expectedVersion: "0",
    nextPosition: position(),
    event: {
      eventId: "event-x",
      eventType: "STOP_MOVED_TO_ENTRY",
      eventIdentity: "idem-x",
      globalEventIdentity: null,
      globalSequence: null,
      occurredAt: "2026-10-11T17:01:00.000Z",
      observedAt: "2026-10-11T17:01:00.000Z",
      payload: {},
    },
    terminalOutcome: null,
  });

  assert.equal(result.kind, "CONCURRENT_CONFLICT");
  assert.equal(calls[0].text, "BEGIN");
  assert.match(calls[1].text, /FOR UPDATE/u);
  assert.ok(calls.some(({ text }) => text === "ROLLBACK"));
});

test("ledger SQL is ownership-scoped, event-idempotent and outcome insert has no update path", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(
    "src/user-trading/ledger/postgres-repository.ts",
    "utf8",
  );

  assert.match(source, /WHERE user_id = \$1[\s\S]*position_id = \$2[\s\S]*FOR UPDATE/u);
  assert.match(source, /event_identity = \$3/u);
  assert.match(source, /INSERT INTO app\.user_position_event/u);
  assert.match(source, /INSERT INTO app\.user_position_outcome/u);
  assert.doesNotMatch(
    source,
    /UPDATE app\.user_position_outcome/u,
  );
  assert.doesNotMatch(
    source,
    /ON CONFLICT[\s\S]*user_position_outcome/iu,
  );
});

test("ledger source imports no frozen auth or session implementation", async () => {
  const { readFileSync } = await import("node:fs");
  for (const file of [
    "src/user-trading/ledger/types.ts",
    "src/user-trading/ledger/outcome.ts",
    "src/user-trading/ledger/repository.ts",
    "src/user-trading/ledger/postgres-repository.ts",
    "src/user-trading/ledger/service.ts",
    "src/user-trading/ledger/index.ts",
  ]) {
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(
      source,
      /from\s+["'][^"']*(?:\/auth\/|\/security\/|require-session|better-auth)/iu,
    );
  }
});
