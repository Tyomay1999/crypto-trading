import test from "node:test";
import assert from "node:assert/strict";

import { DevSignalController } from "../dist/dev-simulator/control.js";
import { createDemoProjection } from "../dist/dev-simulator/scenarios.js";
import { loadDevSimulatorConfig } from "../dist/dev-simulator/config.js";

class RecordingWriter {
  calls = [];

  async publishSignal(signalId, payload) {
    this.calls.push(["publish", signalId, structuredClone(payload)]);
  }
  async appendLifecycleEvent(signalId, payload) {
    this.calls.push(["event", signalId, structuredClone(payload)]);
  }
  async updateSnapshot(signalId, payload) {
    this.calls.push(["snapshot", signalId, structuredClone(payload)]);
  }
  async writeOutcome(signalId, payload) {
    this.calls.push(["outcome", signalId, structuredClone(payload)]);
  }
}

function lastPayload(writer, kind) {
  return writer.calls.filter(([callKind]) => callKind === kind).at(-1)?.[2];
}

test("dev simulator config fails closed in production and without explicit flag", () => {
  assert.throws(
    () => loadDevSimulatorConfig({
      NODE_ENV: "production",
      DELTA_DEV_SIGNAL_SIMULATOR: "on",
      DATABASE_URL: "postgres://local/dev",
    }),
    /never run/,
  );

  assert.throws(
    () => loadDevSimulatorConfig({
      NODE_ENV: "development",
      DATABASE_URL: "postgres://local/dev",
    }),
    /required/,
  );

  assert.throws(
    () => loadDevSimulatorConfig({
      NODE_ENV: "development",
      DELTA_DEV_SIGNAL_SIMULATOR: "on",
      DELTA_DEV_SIGNAL_SIMULATOR_HOST: "0.0.0.0",
      DATABASE_URL: "postgres://local/dev",
    }),
    /loopback only/,
  );
});

test("manual TP3 path runs through prepared runtime operations and remains terminal", async () => {
  const writer = new RecordingWriter();
  const controller = new DevSignalController(writer);

  const projection = createDemoProjection("dev-btc-long");
  const published = await controller.publish("dev-btc-long", projection);

  assert.equal(published.state, "PUBLISHED");
  assert.equal(projection.tradePlan.entry.referencePrice, "118500");
  assert.equal(writer.calls[0][0], "publish");

  assert.equal((await controller.next("dev-btc-long")).state, "WAITING_FOR_ENTRY");
  const entry = await controller.next("dev-btc-long");
  assert.equal(entry.state, "ENTRY_REACHED");
  const stableEntryReachedAt = entry.entryReachedAt;
  assert.ok(stableEntryReachedAt);

  const tp1 = await controller.next("dev-btc-long");
  const tp2 = await controller.next("dev-btc-long");
  const terminal = await controller.next("dev-btc-long");

  assert.equal(tp1.entryReachedAt, stableEntryReachedAt);
  assert.equal(tp2.entryReachedAt, stableEntryReachedAt);
  assert.equal(terminal.entryReachedAt, stableEntryReachedAt);
  assert.equal(lastPayload(writer, "snapshot").entryReachedAt, stableEntryReachedAt);

  assert.equal(terminal.state, "TP3_REACHED");
  assert.equal(terminal.terminal, true);
  assert.equal(writer.calls.filter(([kind]) => kind === "outcome").length, 1);
  assert.equal(lastPayload(writer, "snapshot").actualEntryPrice, "118520");

  await assert.rejects(controller.next("dev-btc-long"), /terminal/);
});

test("STOP is accepted only from entry/tp states and remains fail-closed", async () => {
  const writer = new RecordingWriter();
  const controller = new DevSignalController(writer);
  await controller.publish("dev-stop", createDemoProjection("dev-stop", "ETHUSDT", "SHORT"));

  await assert.rejects(controller.stop("dev-stop"), /not allowed/);

  await controller.next("dev-stop");
  await assert.rejects(controller.stop("dev-stop"), /not allowed/);

  await controller.next("dev-stop");
  const stopped = await controller.stop("dev-stop");
  assert.equal(stopped.state, "STOP_REACHED");
  assert.equal(stopped.terminal, true);

  await assert.rejects(controller.stop("dev-stop"), /terminal/);
});

test("STOP after ENTRY preserves zero reached targets and entry timestamp", async () => {
  const writer = new RecordingWriter();
  const controller = new DevSignalController(writer);

  await controller.publish(
    "dev-stop-entry",
    createDemoProjection("dev-stop-entry", "ETHUSDT", "SHORT"),
  );
  await controller.next("dev-stop-entry");
  const entry = await controller.next("dev-stop-entry");
  await controller.stop("dev-stop-entry");

  const snapshot = lastPayload(writer, "snapshot");
  const outcome = lastPayload(writer, "outcome");

  assert.deepEqual(snapshot.reachedTargets, []);
  assert.equal(snapshot.remainingAllocationFraction, "1");
  assert.equal(snapshot.entryReachedAt, entry.entryReachedAt);
  assert.deepEqual(outcome.reachedTargets, []);
});

test("STOP after TP1 preserves only TP1 reached and stable entry timestamp", async () => {
  const writer = new RecordingWriter();
  const controller = new DevSignalController(writer);

  await controller.publish(
    "dev-stop-tp1",
    createDemoProjection("dev-stop-tp1", "SOLUSDT", "LONG"),
  );
  await controller.next("dev-stop-tp1");
  const entry = await controller.next("dev-stop-tp1");
  await controller.next("dev-stop-tp1");
  await controller.stop("dev-stop-tp1");

  const snapshot = lastPayload(writer, "snapshot");
  const outcome = lastPayload(writer, "outcome");

  assert.deepEqual(snapshot.reachedTargets, ["TP1"]);
  assert.equal(snapshot.remainingAllocationFraction, "0.70");
  assert.equal(snapshot.entryReachedAt, entry.entryReachedAt);
  assert.deepEqual(outcome.reachedTargets, ["TP1"]);
});

test("STOP after TP2 preserves TP1 and TP2 reached and stable entry timestamp", async () => {
  const writer = new RecordingWriter();
  const controller = new DevSignalController(writer);

  await controller.publish(
    "dev-stop-tp2",
    createDemoProjection("dev-stop-tp2", "BTCUSDT", "SHORT"),
  );
  await controller.next("dev-stop-tp2");
  const entry = await controller.next("dev-stop-tp2");
  await controller.next("dev-stop-tp2");
  await controller.next("dev-stop-tp2");
  await controller.stop("dev-stop-tp2");

  const snapshot = lastPayload(writer, "snapshot");
  const outcome = lastPayload(writer, "outcome");

  assert.deepEqual(snapshot.reachedTargets, ["TP1", "TP2"]);
  assert.equal(snapshot.remainingAllocationFraction, "0.40");
  assert.equal(snapshot.entryReachedAt, entry.entryReachedAt);
  assert.deepEqual(outcome.reachedTargets, ["TP1", "TP2"]);
});

test("duplicate publish fails closed before second runtime execution", async () => {
  const writer = new RecordingWriter();
  const controller = new DevSignalController(writer);
  const projection = createDemoProjection("dev-dup");

  await controller.publish("dev-dup", projection);
  await assert.rejects(controller.publish("dev-dup", projection), /already exists/);

  assert.equal(writer.calls.filter(([kind]) => kind === "publish").length, 1);
});

test("dev control source contains no direct ProjectionWriter operation calls", async () => {
  const fs = await import("node:fs/promises");
  const source = await fs.readFile(
    new URL("../src/dev-simulator/control.ts", import.meta.url),
    "utf8",
  );

  assert.match(source, /new SimulatorRuntime/);
  assert.match(source, /runUntilIdle/);
  assert.doesNotMatch(source, /\.publishSignal\(/);
  assert.doesNotMatch(source, /\.appendLifecycleEvent\(/);
  assert.doesNotMatch(source, /\.updateSnapshot\(/);
  assert.doesNotMatch(source, /\.writeOutcome\(/);
});
