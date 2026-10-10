import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

import {
  ApplicationState,
} from "../dist/runtime/application-state.js";
import {
  createApp,
} from "../dist/app.js";

function createReader() {
  const calls = [];

  return {
    calls,

    async listSignals(limit) {
      calls.push({
        operation: "list",
        limit,
      });

      return [
        {
          signalId:
            "signal-route-a",
          projection: {
            id:
              "signal-route-a",
            plannedEntry:
              "100.125",
          },
          current: {
            currentState:
              "TP1_REACHED",
          },
          outcome: null,
        },
      ];
    },

    async getSignal(signalId) {
      calls.push({
        operation:
          "detail",
        signalId,
      });

      if (
        signalId ===
        "signal-missing"
      ) {
        return null;
      }

      return {
        signalId,
        projection: {
          id: signalId,
        },
        current: null,
        outcome: null,
      };
    },

    async getEvents(signalId) {
      calls.push({
        operation:
          "events",
        signalId,
      });

      return {
        signalId,
        events: [
          {
            sequence: 1,
            eventType:
              "SIGNAL_PUBLISHED",
          },
        ],
      };
    },

    async getOutcome(signalId) {
      calls.push({
        operation:
          "outcome",
        signalId,
      });

      return {
        signalId,
        outcome: null,
      };
    },
  };
}

async function withServer(
  reader,
  run,
) {
  const state =
    new ApplicationState();

  const app =
    createApp(
      state,
      {
        databaseReady:
          async () => true,
        authDatabaseReady:
          async () => true,
      },
      undefined,
      undefined,
      undefined,
      undefined,
      {
        reader,
      },
    );

  const server =
    app.listen(
      0,
      "127.0.0.1",
    );

  await once(
    server,
    "listening",
  );

  const address =
    server.address();

  if (
    address === null ||
    typeof address ===
      "string"
  ) {
    throw new Error(
      "Unable to resolve test server.",
    );
  }

  try {
    await run(
      `http://127.0.0.1:${address.port}`,
    );
  } finally {
    await new Promise(
      (resolve, reject) => {
        server.close(
          (error) => {
            if (error) {
              reject(error);
              return;
            }

            resolve();
          },
        );
      },
    );
  }
}

test("GET /api/v1/signals mounts before canonical 404 and defaults limit to 50", async () => {
  const reader =
    createReader();

  await withServer(
    reader,
    async (baseUrl) => {
      const response =
        await fetch(
          `${baseUrl}/api/v1/signals`,
        );

      assert.equal(
        response.status,
        200,
      );
      assert.equal(
        response.headers.get(
          "cache-control",
        ),
        "no-store",
      );

      const body =
        await response.json();

      assert.equal(
        body.signals.length,
        1,
      );
      assert.equal(
        body.signals[0]
          .projection
          .plannedEntry,
        "100.125",
      );
    },
  );

  assert.deepEqual(
    reader.calls[0],
    {
      operation: "list",
      limit: 50,
    },
  );
});

test("signal read API exposes detail, events and active null outcome without auth coupling", async () => {
  const reader =
    createReader();

  await withServer(
    reader,
    async (baseUrl) => {
      const detail =
        await fetch(
          `${baseUrl}/api/v1/signals/signal-route-a`,
        );
      const events =
        await fetch(
          `${baseUrl}/api/v1/signals/signal-route-a/events`,
        );
      const outcome =
        await fetch(
          `${baseUrl}/api/v1/signals/signal-route-a/outcome`,
        );

      assert.equal(
        detail.status,
        200,
      );
      assert.equal(
        events.status,
        200,
      );
      assert.equal(
        outcome.status,
        200,
      );

      assert.equal(
        (
          await detail.json()
        ).signal.signalId,
        "signal-route-a",
      );
      assert.deepEqual(
        (
          await events.json()
        ).events[0],
        {
          sequence: 1,
          eventType:
            "SIGNAL_PUBLISHED",
        },
      );
      assert.equal(
        (
          await outcome.json()
        ).outcome,
        null,
      );
    },
  );
});

test("signal read API uses canonical AppError envelope for missing signal and invalid list query", async () => {
  const reader =
    createReader();

  await withServer(
    reader,
    async (baseUrl) => {
      const missing =
        await fetch(
          `${baseUrl}/api/v1/signals/signal-missing`,
        );

      assert.equal(
        missing.status,
        404,
      );

      const missingBody =
        await missing.json();

      assert.equal(
        missingBody.error.code,
        "SIGNAL_NOT_FOUND",
      );

      const invalid =
        await fetch(
          `${baseUrl}/api/v1/signals?limit=101`,
        );

      assert.equal(
        invalid.status,
        400,
      );

      const invalidBody =
        await invalid.json();

      assert.equal(
        invalidBody.error.code,
        "INVALID_SIGNAL_QUERY",
      );
    },
  );
});
