import assert from "node:assert/strict";
import test from "node:test";

import {
  PostgresProjectionReader,
} from "../dist/projection/reader.js";

class RecordingDatabase {
  constructor(responses) {
    this.responses = [...responses];
    this.calls = [];
  }

  async query(text, values = []) {
    this.calls.push({
      text,
      values,
    });

    const rows =
      this.responses.shift() ?? [];

    return {
      rowCount: rows.length,
      rows,
    };
  }
}

test("projection reader lists canonical projection, current snapshot and outcome separately", async () => {
  const database =
    new RecordingDatabase([
      [
        {
          signal_id: "signal-a",
          projection_payload: {
            id: "signal-a",
            plannedEntry: "100.125",
          },
          snapshot_payload: {
            currentState:
              "ENTRY_REACHED",
          },
          outcome_payload: null,
        },
      ],
    ]);

  const reader =
    new PostgresProjectionReader(
      database,
    );

  const signals =
    await reader.listSignals(25);

  assert.deepEqual(signals, [
    {
      signalId: "signal-a",
      projection: {
        id: "signal-a",
        plannedEntry: "100.125",
      },
      current: {
        currentState:
          "ENTRY_REACHED",
      },
      outcome: null,
    },
  ]);

  assert.match(
    database.calls[0].text,
    /FROM projection\.published_signals p/,
  );
  assert.match(
    database.calls[0].text,
    /LEFT JOIN projection\.signal_current c/,
  );
  assert.match(
    database.calls[0].text,
    /LEFT JOIN projection\.signal_outcomes o/,
  );
  assert.deepEqual(
    database.calls[0].values,
    [25],
  );
});

test("projection reader detail lookup is parameterized and distinguishes missing signal", async () => {
  const database =
    new RecordingDatabase([
      [],
    ]);

  const reader =
    new PostgresProjectionReader(
      database,
    );

  assert.equal(
    await reader.getSignal(
      "signal-missing",
    ),
    null,
  );

  assert.match(
    database.calls[0].text,
    /WHERE p\.signal_id = \$1/,
  );
  assert.deepEqual(
    database.calls[0].values,
    ["signal-missing"],
  );
});

test("projection reader preserves immutable event order and allows an empty event timeline", async () => {
  const database =
    new RecordingDatabase([
      [
        {
          signal_id: "signal-a",
          event_payload: {
            sequence: 1,
            eventType:
              "SIGNAL_PUBLISHED",
          },
        },
        {
          signal_id: "signal-a",
          event_payload: {
            sequence: 2,
            eventType:
              "WAITING_FOR_ENTRY",
          },
        },
      ],
      [
        {
          signal_id: "signal-empty",
          event_payload: null,
        },
      ],
    ]);

  const reader =
    new PostgresProjectionReader(
      database,
    );

  const timeline =
    await reader.getEvents(
      "signal-a",
    );

  assert.deepEqual(
    timeline.events.map(
      (event) => event.sequence,
    ),
    [1, 2],
  );

  assert.match(
    database.calls[0].text,
    /ORDER BY e\.sequence ASC/,
  );

  const empty =
    await reader.getEvents(
      "signal-empty",
    );

  assert.deepEqual(
    empty,
    {
      signalId:
        "signal-empty",
      events: [],
    },
  );
});

test("projection reader returns active signal outcome as null but missing signal as null model", async () => {
  const database =
    new RecordingDatabase([
      [
        {
          signal_id: "signal-active",
          outcome_payload: null,
        },
      ],
      [],
    ]);

  const reader =
    new PostgresProjectionReader(
      database,
    );

  assert.deepEqual(
    await reader.getOutcome(
      "signal-active",
    ),
    {
      signalId:
        "signal-active",
      outcome: null,
    },
  );

  assert.equal(
    await reader.getOutcome(
      "signal-missing",
    ),
    null,
  );
});

test("projection reader rejects unbounded list limits before database access", async () => {
  const database =
    new RecordingDatabase([]);

  const reader =
    new PostgresProjectionReader(
      database,
    );

  await assert.rejects(
    () =>
      reader.listSignals(101),
    TypeError,
  );

  assert.equal(
    database.calls.length,
    0,
  );
});
