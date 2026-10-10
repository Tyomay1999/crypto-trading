import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryProjectionWriter } from "../dist/projection/in-memory-writer.js";

test("in-memory writer preserves projection, timeline, snapshot and outcome separately", async () => {
  const writer = new InMemoryProjectionWriter();

  await writer.publishSignal("signal-a", {
    lifecycleState: "PUBLISHED",
    plannedEntry: "100",
  });
  await writer.appendLifecycleEvent("signal-a", {
    eventType: "ENTRY_REACHED",
    occurredAt: "2026-10-10T10:00:00.000Z",
    actualEntry: "101",
  });
  await writer.updateSnapshot("signal-a", {
    lifecycleState: "ENTRY_REACHED",
    actualEntry: "101",
  });
  await writer.writeOutcome("signal-a", { finalStatus: "STOP" });

  const record = writer.readSignal("signal-a");
  assert.ok(record);
  assert.equal(record.timeline.length, 1);
  assert.equal(record.snapshot.lifecycleState, "ENTRY_REACHED");
  assert.equal(record.outcome.finalStatus, "STOP");
  assert.equal(record.projection.plannedEntry, "100");

  record.timeline[0].eventType = "MUTATED";
  assert.equal(writer.readSignal("signal-a").timeline[0].eventType, "ENTRY_REACHED");
});

test("in-memory writer rejects duplicate terminal outcome", async () => {
  const writer = new InMemoryProjectionWriter();
  await writer.publishSignal("signal-a", { lifecycleState: "PUBLISHED" });
  await writer.writeOutcome("signal-a", { finalStatus: "STOP" });

  await assert.rejects(
    writer.writeOutcome("signal-a", { finalStatus: "TP3" }),
    /already exists/,
  );
});
