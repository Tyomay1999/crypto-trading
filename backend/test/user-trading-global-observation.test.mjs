import test from "node:test";
import assert from "node:assert/strict";

import {
  mapProjectionLifecycleEvent,
  mapProjectionOutcome,
  ProjectionGlobalObservationProvider,
  UserTradingGlobalObservationService,
} from "../dist/user-trading/global-observation/index.js";

test("projection adapter maps TP event without simulator types", () => {
  const observation = mapProjectionLifecycleEvent("signal-a", {
    canonical: {
      signalLifecycleEventId: "evt-1",
      sequence: 2,
      toState: "TP1_REACHED",
      occurredAt: "2026-10-11T12:00:00.000Z",
      price: "110",
      allocationFraction: "0.3",
    },
  });

  assert.deepEqual(observation, {
    kind: "TARGET_REACHED",
    signalId: "signal-a",
    globalEventIdentity: "evt-1",
    globalSequence: "2",
    occurredAt: "2026-10-11T12:00:00.000Z",
    state: "TP1_REACHED",
    target: "TP1",
    price: "110",
    allocationFraction: "0.3",
  });
});

test("projection adapter maps STOP and ignores non-accounting lifecycle states", () => {
  assert.equal(
    mapProjectionLifecycleEvent("signal-a", {
      eventIdentity: "evt-entry",
      sequence: "1",
      state: "ENTRY_REACHED",
      occurredAt: "2026-10-11T11:00:00.000Z",
    }),
    null,
  );

  assert.deepEqual(
    mapProjectionLifecycleEvent("signal-a", {
      eventIdentity: "evt-stop",
      sequence: "3",
      state: "STOP_REACHED",
      occurredAt: "2026-10-11T13:00:00.000Z",
    }),
    {
      kind: "STOP_REACHED",
      signalId: "signal-a",
      globalEventIdentity: "evt-stop",
      globalSequence: "3",
      occurredAt: "2026-10-11T13:00:00.000Z",
      state: "STOP_REACHED",
    },
  );
});

test("projection outcome remains separate observation", () => {
  assert.deepEqual(
    mapProjectionOutcome("signal-a", {
      finalStatus: "TP3",
      asOf: "2026-10-11T14:00:00.000Z",
    }),
    {
      kind: "GLOBAL_OUTCOME",
      signalId: "signal-a",
      globalEventIdentity:
        "global-outcome:signal-a:TP3:2026-10-11T14:00:00.000Z",
      occurredAt: "2026-10-11T14:00:00.000Z",
      finalStatus: "TP3",
    },
  );
});

test("provider reads immutable timeline and outcome from ProjectionReader only", async () => {
  const calls = [];

  const provider =
    new ProjectionGlobalObservationProvider({
      async listSignals() {
        throw new Error("unused");
      },
      async getSignal() {
        throw new Error("unused");
      },
      async getEvents(signalId) {
        calls.push(["events", signalId]);
        return {
          signalId,
          events: [
            {
              eventIdentity: "evt-tp1",
              sequence: "1",
              state: "TP1_REACHED",
              occurredAt: "2026-10-11T11:00:00.000Z",
              price: "110",
              allocationFraction: "0.3",
            },
          ],
        };
      },
      async getOutcome(signalId) {
        calls.push(["outcome", signalId]);
        return {
          signalId,
          outcome: {
            finalStatus: "TP3",
            asOf: "2026-10-11T15:00:00.000Z",
          },
        };
      },
    });

  const observations =
    await provider.readSignalObservations("signal-a");

  assert.equal(observations.length, 2);
  assert.deepEqual(calls, [
    ["events", "signal-a"],
    ["outcome", "signal-a"],
  ]);
});

test("service fans one global TP event to independent user positions", async () => {
  const calls = [];

  const service =
    new UserTradingGlobalObservationService(
      {
        async listOpenPositionsForSignal(signalId) {
          assert.equal(signalId, "signal-a");
          return [
            { userId: "user-a", positionId: "position-a" },
            { userId: "user-b", positionId: "position-b" },
          ];
        },
      },
      {
        async applyTarget(input) {
          calls.push(input);
          return {};
        },
        async applyStop() {
          throw new Error("unexpected");
        },
        async manualExit() {
          throw new Error("unexpected");
        },
        async moveStop() {
          throw new Error("unexpected");
        },
        async observeGlobalOutcome() {
          throw new Error("unexpected");
        },
      },
    );

  const result = await service.apply({
    kind: "TARGET_REACHED",
    signalId: "signal-a",
    globalEventIdentity: "global-event-1",
    globalSequence: "9",
    occurredAt: "2026-10-11T12:00:00.000Z",
    state: "TP1_REACHED",
    target: "TP1",
    price: "110",
    allocationFraction: "0.3",
  });

  assert.equal(result.positionsObserved, 2);
  assert.equal(calls.length, 2);
  assert.deepEqual(
    calls.map((call) => [
      call.userId,
      call.positionId,
      call.eventIdentity,
      call.globalEventIdentity,
      call.observedAt,
      call.target.globalSequence,
      call.target.allocationFraction,
    ]),
    [
      [
        "user-a",
        "position-a",
        "global-event-1",
        "global-event-1",
        "2026-10-11T12:00:00.000Z",
        "9",
        "0.3",
      ],
      [
        "user-b",
        "position-b",
        "global-event-1",
        "global-event-1",
        "2026-10-11T12:00:00.000Z",
        "9",
        "0.3",
      ],
    ],
  );
});

test("same global STOP is delegated independently so current user stop remains authoritative", async () => {
  const calls = [];

  const service =
    new UserTradingGlobalObservationService(
      {
        async listOpenPositionsForSignal() {
          return [
            { userId: "user-a", positionId: "position-a" },
            { userId: "user-b", positionId: "position-b" },
          ];
        },
      },
      {
        async applyTarget() {
          throw new Error("unexpected");
        },
        async applyStop(input) {
          calls.push(input);
          return {};
        },
        async manualExit() {
          throw new Error("unexpected");
        },
        async moveStop() {
          throw new Error("unexpected");
        },
        async observeGlobalOutcome() {
          throw new Error("unexpected");
        },
      },
    );

  await service.apply({
    kind: "STOP_REACHED",
    signalId: "signal-a",
    globalEventIdentity: "global-stop-7",
    globalSequence: "7",
    occurredAt: "2026-10-11T13:00:00.000Z",
    state: "STOP_REACHED",
  });

  assert.equal(calls.length, 2);
  assert.ok(calls.every(
    (call) =>
      call.eventIdentity === "global-stop-7" &&
      call.globalEventIdentity === "global-stop-7" &&
      call.observedAt === "2026-10-11T13:00:00.000Z" &&
      call.stop.globalSequence === "7",
  ));
});

test("global outcome is delegated separately from realized mutation", async () => {
  const calls = [];

  const service =
    new UserTradingGlobalObservationService(
      {
        async listOpenPositionsForSignal() {
          return [
            { userId: "user-a", positionId: "position-a" },
          ];
        },
      },
      {
        async applyTarget() {
          throw new Error("unexpected");
        },
        async applyStop() {
          throw new Error("unexpected");
        },
        async manualExit() {
          throw new Error("unexpected");
        },
        async moveStop() {
          throw new Error("unexpected");
        },
        async observeGlobalOutcome(input) {
          calls.push(input);
          return {};
        },
      },
    );

  await service.apply({
    kind: "GLOBAL_OUTCOME",
    signalId: "signal-a",
    globalEventIdentity: "outcome-observation-1",
    occurredAt: "2026-10-11T15:00:00.000Z",
    finalStatus: "TP3",
  });

  assert.deepEqual(calls, [{
    userId: "user-a",
    positionId: "position-a",
    eventIdentity: "outcome-observation-1",
    globalEventIdentity: "outcome-observation-1",
    globalSequence: "0",
    occurredAt: "2026-10-11T15:00:00.000Z",
    observedAt: "2026-10-11T15:00:00.000Z",
    globalTerminalStatus: "TP3",
  }]);
});
