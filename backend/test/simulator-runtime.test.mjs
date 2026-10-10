import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryProjectionWriter } from "../dist/projection/in-memory-writer.js";
import { SimulatorRuntime } from "../dist/simulator/runtime.js";

function stopScenario(signalId, stopOffset, reachedTargets) {
  return {
    name: `STOP_${signalId}`,
    signalId,
    seed: "scenario-seed",
    steps: [
      {
        kind: "publishSignal",
        offsetMs: 0,
        projection: { lifecycleState: "PUBLISHED" },
      },
      {
        kind: "appendLifecycleEvent",
        offsetMs: 1000,
        event: {
          eventType: "ENTRY_REACHED",
          occurredAt: "2026-10-10T10:00:01.000Z",
        },
      },
      ...reachedTargets.map((target, index) => ({
        kind: "appendLifecycleEvent",
        offsetMs: 2000 + index * 1000,
        event: {
          eventType: `${target}_REACHED`,
          occurredAt: `2026-10-10T10:00:0${2 + index}.000Z`,
        },
      })),
      {
        kind: "writeOutcome",
        offsetMs: stopOffset,
        outcome: { finalStatus: "STOP", reachedTargets },
      },
    ],
  };
}

test("runtime executes multiple signals deterministically while preserving distinct STOP histories", async () => {
  const writer = new InMemoryProjectionWriter();
  const runtime = new SimulatorRuntime(writer, {
    seed: "runtime-seed",
    startTime: "2026-10-10T10:00:00.000Z",
  });

  runtime.addScenario(stopScenario("signal-entry-stop", 2000, []));
  runtime.addScenario(stopScenario("signal-tp2-stop", 5000, ["TP1", "TP2"]));

  const executed = await runtime.runUntilIdle();
  assert.equal(executed, 8);

  const entryStop = writer.readSignal("signal-entry-stop");
  const tp2Stop = writer.readSignal("signal-tp2-stop");

  assert.ok(entryStop);
  assert.ok(tp2Stop);
  assert.equal(entryStop.outcome.finalStatus, "STOP");
  assert.equal(tp2Stop.outcome.finalStatus, "STOP");
  assert.equal(entryStop.timeline.length, 1);
  assert.equal(tp2Stop.timeline.length, 3);
  assert.deepEqual(tp2Stop.outcome.reachedTargets, ["TP1", "TP2"]);
  assert.equal(runtime.clock.now().toISOString(), "2026-10-10T10:00:05.000Z");
});
