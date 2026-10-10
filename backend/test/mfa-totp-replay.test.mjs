import assert from "node:assert/strict";
import test from "node:test";

import {
  createTotpReplayDigest,
} from "../dist/auth/totp-replay.js";

import {
  deleteTotpChallengeSession,
  deleteTotpEnrollmentSession,
  disableTotpAndRevokeAllSessions,
  finalizeTotpEnrollmentVerification,
  finalizeTotpLoginChallenge,
  getTotpEnrollmentState,
} from "../dist/storage/totp-replay.js";

test(
  "TOTP replay digest is deterministic, keyed and user-bound",
  () => {
    const pepper =
      "p".repeat(64);

    const first =
      createTotpReplayDigest(
        pepper,
        "user-a",
        "123456",
      );

    const same =
      createTotpReplayDigest(
        pepper,
        "user-a",
        "123456",
      );

    const otherUser =
      createTotpReplayDigest(
        pepper,
        "user-b",
        "123456",
      );

    const otherPepper =
      createTotpReplayDigest(
        "q".repeat(64),
        "user-a",
        "123456",
      );

    assert.equal(
      first,
      same,
    );

    assert.notEqual(
      first,
      otherUser,
    );

    assert.notEqual(
      first,
      otherPepper,
    );

    assert.match(
      first,
      /^[a-f0-9]{64}$/,
    );

    assert.equal(
      first.includes("123456"),
      false,
    );
  },
);

test(
  "TOTP replay digest rejects malformed credentials",
  () => {
    assert.throws(
      () =>
        createTotpReplayDigest(
          "p".repeat(64),
          "user-a",
          "12345",
        ),
    );

    assert.throws(
      () =>
        createTotpReplayDigest(
          "short",
          "user-a",
          "123456",
        ),
    );
  },
);

test(
  "pending enrollment state does not select TOTP secret",
  async () => {
    const calls = [];

    const database = {
      query: async (
        sql,
        values,
      ) => {
        calls.push({
          sql,
          values,
        });

        return {
          rowCount: 1,
          rows: [
            {
              twoFactorEnabled:
                false,
              verified:
                false,
            },
          ],
        };
      },
    };

    assert.equal(
      await getTotpEnrollmentState(
        database,
        "user-a",
      ),
      "pending",
    );

    assert.doesNotMatch(
      calls[0].sql,
      /SELECT[\s\S]*secret/i,
    );

    assert.doesNotMatch(
      calls[0].sql,
      /backupCodes/i,
    );
  },
);

function transactionDatabase(
  claimRowCount = 1,
) {
  const calls = [];

  const client = {
    query: async (
      sql,
      values = [],
    ) => {
      calls.push({
        sql,
        values,
      });

      if (
        /SELECT[\s\S]*FROM auth\."session"/i
          .test(sql)
      ) {
        return {
          rowCount: 1,
          rows: [
            {
              userId:
                "user-a",
            },
          ],
        };
      }

      if (
        /INSERT INTO app\.auth_totp_replay_guard/i
          .test(sql)
      ) {
        return {
          rowCount:
            claimRowCount,
          rows:
            claimRowCount === 1
              ? [
                  {
                    user_id:
                      "user-a",
                  },
                ]
              : [],
        };
      }

      if (
        /DELETE FROM auth\."session"/i
          .test(sql)
      ) {
        return {
          rowCount: 1,
          rows: [],
        };
      }

      return {
        rowCount: 0,
        rows: [],
      };
    },

    release: () => {
      calls.push({
        sql:
          "RELEASE",
        values: [],
      });
    },
  };

  return {
    calls,

    database: {
      connect:
        async () =>
          client,
    },
  };
}

test(
  "fresh login TOTP replay claim commits without deleting winner session",
  async () => {
    const {
      calls,
      database,
    } =
      transactionDatabase(
        1,
      );

    assert.equal(
      await finalizeTotpLoginChallenge(
        database,
        "login-session-token",
        "user-a",
        "a".repeat(64),
        new Date(
          "2026-09-07T08:00:00.000Z",
        ),
        new Date(
          "2026-09-07T08:05:00.000Z",
        ),
      ),
      true,
    );

    assert.equal(
      calls.some(
        (entry) =>
          /DELETE FROM auth\."session"/
            .test(entry.sql),
      ),
      false,
    );
  },
);

test(
  "enrollment replay winner preserves only rotated current session id",
  async () => {
    const {
      calls,
      database,
    } =
      transactionDatabase(
        1,
      );

    assert.equal(
      await finalizeTotpEnrollmentVerification(
        database,
        "new-mfa-session",
        "user-a",
        "b".repeat(64),
        new Date(
          "2026-09-07T08:00:00.000Z",
        ),
        new Date(
          "2026-09-07T08:05:00.000Z",
        ),
      ),
      true,
    );

    const revoke =
      calls.find(
        (entry) =>
          /DELETE FROM auth\."session"/
            .test(entry.sql),
      );

    assert.ok(revoke);

    assert.match(
      revoke.sql,
      /"id"\s*<>\s*\$2/,
    );

    assert.deepEqual(
      revoke.values,
      [
        "user-a",
        "new-mfa-session",
      ],
    );
  },
);

test(
  "concurrent enrollment replay loser deletes its newly rotated session",
  async () => {
    const {
      calls,
      database,
    } =
      transactionDatabase(
        0,
      );

    assert.equal(
      await finalizeTotpEnrollmentVerification(
        database,
        "loser-session",
        "user-a",
        "c".repeat(64),
        new Date(
          "2026-09-07T08:00:00.000Z",
        ),
        new Date(
          "2026-09-07T08:05:00.000Z",
        ),
      ),
      false,
    );

    assert.ok(
      calls.some(
        (entry) =>
          /DELETE FROM auth\."session"/
            .test(entry.sql),
      ),
    );
  },
);

test(
  "TOTP disable atomically removes factor, replay state and every user session",
  async () => {
    const calls = [];

    const client = {
      query: async (
        sql,
        values = [],
      ) => {
        calls.push({
          sql,
          values,
        });

        if (
          /SELECT[\s\S]*"twoFactorEnabled"[\s\S]*FROM auth\."user"/i
            .test(sql)
        ) {
          return {
            rowCount: 1,
            rows: [
              {
                twoFactorEnabled:
                  true,
              },
            ],
          };
        }

        if (
          /SELECT[\s\S]*"verified"[\s\S]*FROM auth\."twoFactor"/i
            .test(sql)
        ) {
          return {
            rowCount: 1,
            rows: [
              {
                verified:
                  true,
              },
            ],
          };
        }

        if (
          /DELETE FROM auth\."twoFactor"/i
            .test(sql)
        ) {
          return {
            rowCount: 1,
            rows: [],
          };
        }

        return {
          rowCount: 3,
          rows: [],
        };
      },

      release: () => {},
    };

    const database = {
      connect:
        async () =>
          client,
    };

    assert.equal(
      await disableTotpAndRevokeAllSessions(
        database,
        "user-a",
        new Date(
          "2026-09-07T08:00:00.000Z",
        ),
      ),
      true,
    );

    assert.ok(
      calls.some(
        (entry) =>
          /UPDATE auth\."user"/
            .test(entry.sql) &&
          /"twoFactorEnabled"\s*=\s*FALSE/
            .test(entry.sql),
      ),
    );

    assert.ok(
      calls.some(
        (entry) =>
          /DELETE FROM auth\."twoFactor"/
            .test(entry.sql),
      ),
    );

    assert.ok(
      calls.some(
        (entry) =>
          /DELETE FROM app\.auth_totp_replay_guard/
            .test(entry.sql),
      ),
    );

    assert.ok(
      calls.some(
        (entry) =>
          /DELETE FROM app\.auth_recovery_code_set/
            .test(entry.sql) &&
          entry.values[0] === "user-a",
      ),
    );

    assert.ok(
      calls.some(
        (entry) =>
          /DELETE FROM auth\."session"/
            .test(entry.sql),
      ),
    );

    assert.equal(
      calls[0].sql,
      "BEGIN",
    );

    assert.ok(
      calls.some(
        (entry) =>
          entry.sql ===
          "COMMIT",
      ),
    );
  },
);

test(
  "best-effort challenge cleanup is token and user scoped",
  async () => {
    const calls = [];

    const database = {
      query: async (
        sql,
        values,
      ) => {
        calls.push({
          sql,
          values,
        });

        return {
          rowCount: 1,
          rows: [],
        };
      },
    };

    assert.equal(
      await deleteTotpChallengeSession(
        database,
        "server-only-token",
        "user-a",
      ),
      true,
    );

    assert.deepEqual(
      calls[0].values,
      [
        "server-only-token",
        "user-a",
      ],
    );
  },
);


test(
  "enrollment replay is DB-session-id bound while login replay remains token bound",
  async () => {
    const enrollment =
      transactionDatabase(
        1,
      );

    assert.equal(
      await finalizeTotpEnrollmentVerification(
        enrollment.database,
        "rotated-session-id",
        "user-a",
        "d".repeat(64),
        new Date(
          "2026-09-07T09:00:00.000Z",
        ),
        new Date(
          "2026-09-07T09:05:00.000Z",
        ),
      ),
      true,
    );

    const enrollmentLock =
      enrollment.calls.find(
        (entry) =>
          /SELECT[\s\S]*FROM auth\."session"[\s\S]*FOR UPDATE/
            .test(
              entry.sql,
            ),
      );

    assert.ok(
      enrollmentLock,
    );

    assert.match(
      enrollmentLock.sql,
      /WHERE "id"\s*=\s*\$1/,
    );

    assert.doesNotMatch(
      enrollmentLock.sql,
      /WHERE "token"\s*=\s*\$1/,
    );

    const enrollmentRevoke =
      enrollment.calls.find(
        (entry) =>
          /DELETE FROM auth\."session"[\s\S]*<>/
            .test(
              entry.sql,
            ),
      );

    assert.ok(
      enrollmentRevoke,
    );

    assert.match(
      enrollmentRevoke.sql,
      /"id"\s*<>\s*\$2/,
    );

    const login =
      transactionDatabase(
        1,
      );

    assert.equal(
      await finalizeTotpLoginChallenge(
        login.database,
        "login-session-token",
        "user-a",
        "e".repeat(64),
        new Date(
          "2026-09-07T09:10:00.000Z",
        ),
        new Date(
          "2026-09-07T09:15:00.000Z",
        ),
      ),
      true,
    );

    const loginLock =
      login.calls.find(
        (entry) =>
          /SELECT[\s\S]*FROM auth\."session"[\s\S]*FOR UPDATE/
            .test(
              entry.sql,
            ),
      );

    assert.ok(
      loginLock,
    );

    assert.match(
      loginLock.sql,
      /WHERE "token"\s*=\s*\$1/,
    );
  },
);

test(
  "enrollment cleanup deletes only the rotated DB session id",
  async () => {
    const calls = [];

    const database = {
      query: async (
        sql,
        values = [],
      ) => {
        calls.push({
          sql,
          values,
        });

        return {
          rowCount: 1,
          rows: [],
        };
      },
    };

    await deleteTotpEnrollmentSession(
      database,
      "rotated-session-id",
      "user-a",
    );

    assert.equal(
      calls.length,
      1,
    );

    assert.match(
      calls[0].sql,
      /DELETE FROM auth\."session"/,
    );

    assert.match(
      calls[0].sql,
      /WHERE "id"\s*=\s*\$1/,
    );

    assert.deepEqual(
      calls[0].values,
      [
        "rotated-session-id",
        "user-a",
      ],
    );
  },
);
