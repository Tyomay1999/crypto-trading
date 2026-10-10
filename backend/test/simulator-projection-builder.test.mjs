import assert from "node:assert/strict";
import test from "node:test";
import { buildProjectionWriterOperation } from "../dist/simulator/projection-builder.js";

test("projection builder maps prepared domain output without recreating DR internals", () => {
  const event = {
    kind: "appendLifecycleEvent",
    offsetMs: 10,
    event: {
      eventType: "TP1_REACHED",
      occurredAt: "2026-10-10T10:00:00.010Z",
    },
  };

  const operation = buildProjectionWriterOperation(event);
  assert.deepEqual(operation, {
    kind: "appendLifecycleEvent",
    payload: event.event,
  });

  operation.payload.eventType = "MUTATED";
  assert.equal(event.event.eventType, "TP1_REACHED");
});
