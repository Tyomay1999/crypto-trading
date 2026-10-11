import assert from "node:assert/strict";
import test from "node:test";

import { DevAutoplayService } from "../dist/dev-simulator/autoplay.js";

const NEXT = {
  PUBLISHED: "WAITING_FOR_ENTRY",
  WAITING_FOR_ENTRY: "ENTRY_REACHED",
  ENTRY_REACHED: "TP1_REACHED",
  TP1_REACHED: "TP2_REACHED",
  TP2_REACHED: "TP3_REACHED",
};

class FakeController {
  constructor(signalId = "auto-signal") {
    this.record = {
      signalId,
      projection: {},
      state: "PUBLISHED",
      sequence: 0,
      terminal: false,
      entryReachedAt: null,
    };
    this.calls = [];
  }

  get(signalId) {
    return signalId === this.record.signalId
      ? structuredClone(this.record)
      : undefined;
  }

  async next(signalId) {
    this.calls.push(["next", signalId]);
    const state = NEXT[this.record.state];
    if (!state) throw new Error(`Signal ${signalId} is terminal.`);
    this.record = {
      ...this.record,
      state,
      sequence: this.record.sequence + 1,
      terminal: state === "TP3_REACHED",
      entryReachedAt:
        state === "ENTRY_REACHED"
          ? "2026-10-11T10:00:02.000Z"
          : this.record.entryReachedAt,
    };
    return structuredClone(this.record);
  }

  async stop(signalId) {
    this.calls.push(["stop", signalId]);
    if (!["ENTRY_REACHED", "TP1_REACHED", "TP2_REACHED"].includes(this.record.state)) {
      throw new Error(`STOP is not allowed from ${this.record.state}.`);
    }
    this.record = {
      ...this.record,
      state: "STOP_REACHED",
      sequence: this.record.sequence + 1,
      terminal: true,
    };
    return structuredClone(this.record);
  }
}

function immediateSleep(log) {
  return async (milliseconds) => {
    log.push(milliseconds);
  };
}

for (const [scenario, expectedState, expectedNextCalls, expectedStopCalls] of [
  ["TP3", "TP3_REACHED", 5, 0],
  ["STOP_AFTER_ENTRY", "STOP_REACHED", 2, 1],
  ["STOP_AFTER_TP1", "STOP_REACHED", 3, 1],
  ["STOP_AFTER_TP2", "STOP_REACHED", 4, 1],
]) {
  test(`${scenario} follows deterministic lifecycle path`, async () => {
    const controller = new FakeController(`signal-${scenario}`);
    const sleeps = [];
    const autoplay = new DevAutoplayService(
      controller,
      immediateSleep(sleeps),
    );

    const terminal = await autoplay.run(
      controller.record.signalId,
      scenario,
      { delayMs: 2500 },
    );

    assert.equal(terminal.state, expectedState);
    assert.equal(terminal.terminal, true);
    assert.equal(
      controller.calls.filter(([kind]) => kind === "next").length,
      expectedNextCalls,
    );
    assert.equal(
      controller.calls.filter(([kind]) => kind === "stop").length,
      expectedStopCalls,
    );
    assert.ok(sleeps.length >= expectedNextCalls);
    assert.ok(sleeps.every((value) => value === 2500));
    assert.equal(autoplay.isRunning(controller.record.signalId), false);
  });
}

test("autoplay delay is bounded and fail-closed", async () => {
  const controller = new FakeController();
  const autoplay = new DevAutoplayService(controller, async () => {});

  await assert.rejects(
    autoplay.run(controller.record.signalId, "TP3", { delayMs: -1 }),
    /between 0 and 60000/,
  );
  await assert.rejects(
    autoplay.run(controller.record.signalId, "TP3", { delayMs: 60_001 }),
    /between 0 and 60000/,
  );
  await assert.rejects(
    autoplay.run(controller.record.signalId, "TP3", { delayMs: 1.5 }),
    /between 0 and 60000/,
  );
});

test("autoplay requires an existing PUBLISHED non-terminal signal", async () => {
  const controller = new FakeController();
  const autoplay = new DevAutoplayService(controller, async () => {});

  await assert.rejects(
    autoplay.run("missing", "TP3", { delayMs: 0 }),
    /Unknown DEV signal/,
  );

  controller.record = {
    ...controller.record,
    state: "ENTRY_REACHED",
    sequence: 2,
  };
  await assert.rejects(
    autoplay.run(controller.record.signalId, "TP3", { delayMs: 0 }),
    /requires PUBLISHED/,
  );
});

test("single-flight guard rejects overlapping autoplay for one signal", async () => {
  const controller = new FakeController();
  let release;
  const firstSleep = new Promise((resolve) => {
    release = resolve;
  });
  let sleepCount = 0;

  const autoplay = new DevAutoplayService(controller, async () => {
    sleepCount += 1;
    if (sleepCount === 1) await firstSleep;
  });

  const first = autoplay.run(controller.record.signalId, "TP3", { delayMs: 0 });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(autoplay.isRunning(controller.record.signalId), true);

  await assert.rejects(
    autoplay.run(controller.record.signalId, "TP3", { delayMs: 0 }),
    /already running/,
  );

  release();
  await first;
  assert.equal(autoplay.isRunning(controller.record.signalId), false);
});
