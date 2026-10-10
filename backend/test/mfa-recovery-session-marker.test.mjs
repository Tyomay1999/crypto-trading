import assert from "node:assert/strict";
import test from "node:test";

import { insertRecoverySessionMarker } from "../dist/storage/recovery-session-marker.js";

test("recovery session marker stores provenance only", async () => {
  const calls = [];
  const authenticatedAt = new Date("2026-09-08T12:00:00.000Z");

  await insertRecoverySessionMarker(
    {
      async create(input) {
        calls.push(input);
        return { id: "marker-a" };
      },
    },
    "session-a",
    authenticatedAt,
  );

  assert.deepEqual(calls, [
    {
      model: "recoverySessionMarker",
      data: {
        sessionId: "session-a",
        authenticatedAt,
      },
    },
  ]);
  assert.doesNotMatch(
    JSON.stringify(calls),
    /code|digest|generation|strong|token/i,
  );
});

test("marker failure aborts instead of silently accepting an unmarked session", async () => {
  await assert.rejects(
    insertRecoverySessionMarker(
      {
        async create() {
          return null;
        },
      },
      "session-a",
      new Date(),
    ),
    /provenance insertion failed/,
  );
});
