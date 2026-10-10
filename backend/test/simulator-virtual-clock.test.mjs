import assert from "node:assert/strict";
import test from "node:test";
import { VirtualClock } from "../dist/simulator/virtual-clock.js";

test("virtual clock advances deterministically and never moves backwards", () => {
  const clock = new VirtualClock("2026-10-10T10:00:00.000Z");
  const start = clock.nowEpochMs();

  clock.advanceBy(5000);
  assert.equal(clock.nowEpochMs(), start + 5000);
  assert.equal(clock.now().toISOString(), "2026-10-10T10:00:05.000Z");
  assert.throws(() => clock.advanceTo(start), /backwards/);
});
