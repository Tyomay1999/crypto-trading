import assert from "node:assert/strict";
import test from "node:test";

import {
  LIFECYCLE_STATES,
  PROJECTION_CONTRACT_V1_SCHEMA_SHA256,
  TERMINAL_STATUSES,
  isLifecycleState,
  isTerminalStatus,
} from "../dist/projection/contract.js";
import {
  assertDecimalString,
  assertOccurredAt,
} from "../dist/projection/validation.js";

test("projection contract foundation freezes observed lifecycle and terminal domains", () => {
  assert.deepEqual(LIFECYCLE_STATES, [
    "PUBLISHED",
    "WAITING_FOR_ENTRY",
    "ENTRY_REACHED",
    "TP1_REACHED",
    "TP2_REACHED",
    "TP3_REACHED",
    "STOP_REACHED",
  ]);
  assert.deepEqual(TERMINAL_STATUSES, ["STOP", "TP3"]);
  assert.equal(isLifecycleState("TP2_REACHED"), true);
  assert.equal(isLifecycleState("EXPIRED"), false);
  assert.equal(isTerminalStatus("STOP"), true);
  assert.equal(isTerminalStatus("NO_ENTRY"), false);
  assert.equal(
    PROJECTION_CONTRACT_V1_SCHEMA_SHA256,
    "dbdd0af64715596f705f3dff74f368fd1815dc26e22f326ddba10b400fa9dfa1",
  );
});

test("projection boundary validates decimal strings and occurredAt domain timestamps", () => {
  assert.doesNotThrow(() => assertDecimalString("78242.125"));
  assert.doesNotThrow(() => assertDecimalString("-0.004070703714"));
  assert.throws(() => assertDecimalString(78242.125));
  assert.throws(() => assertDecimalString("NaN"));
  assert.doesNotThrow(() => assertOccurredAt("2026-09-18T09:00:04.753000Z"));
  assert.throws(() => assertOccurredAt("not-a-time"));
});
