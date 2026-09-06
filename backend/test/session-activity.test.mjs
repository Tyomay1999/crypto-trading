import assert from "node:assert/strict";
import test from "node:test";

import {
  getSessionActivities,
  touchSessionActivity,
} from "../dist/storage/session-activity.js";

test(
  "touchSessionActivity inserts or advances activity with five-minute throttling",
  async () => {
    const observedAt =
      new Date("2026-09-06T18:00:00.000Z");

    let capturedSql = "";
    let capturedParameters;

    const database = {
      query: async (sql, parameters) => {
        capturedSql = sql;
        capturedParameters = parameters;

        return {
          rowCount: 1,
          rows: [
            {
              session_id:
                "session-a",
              last_activity_at:
                observedAt,
            },
          ],
        };
      },
    };

    const result =
      await touchSessionActivity(
        database,
        "session-a",
        observedAt,
      );

    assert.equal(
      result.updated,
      true,
    );

    assert.equal(
      result.lastActivityAt,
      observedAt,
    );

    assert.match(
      capturedSql,
      /INSERT\s+INTO\s+app\.auth_session_activity/i,
    );

    assert.match(
      capturedSql,
      /ON\s+CONFLICT\s*\(\s*session_id\s*\)/i,
    );

    assert.match(
      capturedSql,
      /INTERVAL\s+'5 minutes'/i,
    );

    assert.match(
      capturedSql,
      /RETURNING[\s\S]*last_activity_at/i,
    );

    assert.deepEqual(
      capturedParameters,
      [
        "session-a",
        observedAt,
      ],
    );
  },
);

test(
  "touchSessionActivity reports a throttled observation without fabricating a timestamp",
  async () => {
    const database = {
      query: async () => ({
        rowCount: 0,
        rows: [],
      }),
    };

    const result =
      await touchSessionActivity(
        database,
        "session-a",
        new Date(
          "2026-09-06T18:01:00.000Z",
        ),
      );

    assert.deepEqual(
      result,
      {
        updated: false,
        lastActivityAt: null,
      },
    );
  },
);

test(
  "touchSessionActivity rejects empty session identity",
  async () => {
    await assert.rejects(
      () =>
        touchSessionActivity(
          {
            query: async () => {
              throw new Error(
                "query must not execute",
              );
            },
          },
          "   ",
          new Date(),
        ),
      /must not be empty/i,
    );
  },
);

test(
  "touchSessionActivity rejects invalid activity timestamp",
  async () => {
    await assert.rejects(
      () =>
        touchSessionActivity(
          {
            query: async () => {
              throw new Error(
                "query must not execute",
              );
            },
          },
          "session-a",
          new Date(Number.NaN),
        ),
      /timestamp must be valid/i,
    );
  },
);

test(
  "getSessionActivities performs one bounded bulk lookup",
  async () => {
    let queryCount = 0;
    let capturedSql = "";
    let capturedParameters;

    const first =
      new Date(
        "2026-09-06T18:00:00.000Z",
      );

    const second =
      new Date(
        "2026-09-06T18:05:00.000Z",
      );

    const database = {
      query: async (sql, parameters) => {
        queryCount += 1;
        capturedSql = sql;
        capturedParameters = parameters;

        return {
          rowCount: 2,
          rows: [
            {
              session_id:
                "session-a",
              last_activity_at:
                first,
            },
            {
              session_id:
                "session-b",
              last_activity_at:
                second,
            },
          ],
        };
      },
    };

    const activities =
      await getSessionActivities(
        database,
        [
          "session-a",
          "session-b",
        ],
      );

    assert.equal(
      queryCount,
      1,
    );

    assert.match(
      capturedSql,
      /ANY\s*\(\s*\$1::text\[\]\s*\)/i,
    );

    assert.deepEqual(
      capturedParameters,
      [
        [
          "session-a",
          "session-b",
        ],
      ],
    );

    assert.equal(
      activities.get(
        "session-a",
      ),
      first,
    );

    assert.equal(
      activities.get(
        "session-b",
      ),
      second,
    );
  },
);

test(
  "getSessionActivities skips database access for an empty session set",
  async () => {
    let queried = false;

    const activities =
      await getSessionActivities(
        {
          query: async () => {
            queried = true;
            throw new Error(
              "query must not execute",
            );
          },
        },
        [],
      );

    assert.equal(
      queried,
      false,
    );

    assert.equal(
      activities.size,
      0,
    );
  },
);
