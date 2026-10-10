import assert from "node:assert/strict";
import {
  readFile,
} from "node:fs/promises";
import test from "node:test";

import {
  createEmailVerificationReplayDigest,
  parseEmailVerificationReplayPayload,
} from "../dist/auth/email-verification-replay.js";
import {
  claimEmailVerificationReplayToken,
} from "../dist/storage/email-verification-replay.js";

const digestPattern =
  /^[0-9a-f]{64}$/;

test(
  "email verification replay digest is deterministic and user-bound",
  () => {
    const token =
      "signed-verification-token-value";

    const first =
      createEmailVerificationReplayDigest(
        "user-a",
        token,
      );

    const second =
      createEmailVerificationReplayDigest(
        "user-a",
        token,
      );

    const otherUser =
      createEmailVerificationReplayDigest(
        "user-b",
        token,
      );

    assert.match(
      first,
      digestPattern,
    );

    assert.equal(
      first,
      second,
    );

    assert.notEqual(
      first,
      otherUser,
    );

    assert.notEqual(
      first,
      token,
    );
  },
);

test(
  "email verification replay payload preserves expiry and email-change distinction",
  () => {
    const observedAt =
      new Date(
        "2026-09-07T20:00:00.000Z",
      );

    const normal =
      parseEmailVerificationReplayPayload(
        {
          email:
            "User@Example.COM",
          exp:
            1788814800,
        },
        observedAt,
      );

    assert.ok(
      normal,
    );

    assert.equal(
      normal.email,
      "user@example.com",
    );

    assert.equal(
      normal.isEmailChange,
      false,
    );

    const emailChange =
      parseEmailVerificationReplayPayload(
        {
          email:
            "user@example.com",
          updateTo:
            "next@example.com",
          requestType:
            "change-email-confirmation",
          exp:
            1788814800,
        },
        observedAt,
      );

    assert.ok(
      emailChange,
    );

    assert.equal(
      emailChange.isEmailChange,
      true,
    );

    const expired =
      parseEmailVerificationReplayPayload(
        {
          email:
            "user@example.com",
          exp:
            1,
        },
        observedAt,
      );

    assert.equal(
      expired,
      null,
    );
  },
);

function fakePool(
  insertRowCount,
) {
  const calls = [];

  const client = {
    async query(
      sql,
      parameters = [],
    ) {
      calls.push({
        sql,
        parameters,
      });

      if (
        /INSERT INTO[\s\S]*auth_email_verification_replay_guard/
          .test(sql)
      ) {
        return {
          rowCount:
            insertRowCount,
          rows:
            insertRowCount === 1
              ? [
                  {
                    token_digest:
                      "a".repeat(64),
                  },
                ]
              : [],
        };
      }

      return {
        rowCount: 0,
        rows: [],
      };
    },

    release() {
      calls.push({
        sql:
          "RELEASE",
        parameters: [],
      });
    },
  };

  return {
    pool: {
      async connect() {
        return client;
      },
    },

    calls,
  };
}

test(
  "email verification replay storage atomically accepts the first claim",
  async () => {
    const fake =
      fakePool(
        1,
      );

    const accepted =
      await claimEmailVerificationReplayToken(
        fake.pool,
        {
          userId:
            "user-1",
          tokenDigest:
            "a".repeat(64),
          acceptedAt:
            new Date(
              "2026-09-07T20:00:00.000Z",
            ),
          expiresAt:
            new Date(
              "2026-09-07T21:00:00.000Z",
            ),
        },
      );

    assert.equal(
      accepted,
      true,
    );

    const sql =
      fake.calls
        .map(
          (entry) =>
            entry.sql,
        )
        .join(
          "\n",
        );

    assert.match(
      sql,
      /\bBEGIN\b/,
    );

    assert.match(
      sql,
      /DELETE FROM[\s\S]*auth_email_verification_replay_guard/,
    );

    assert.match(
      sql,
      /ON CONFLICT[\s\S]*user_id[\s\S]*token_digest[\s\S]*DO NOTHING/,
    );

    assert.match(
      sql,
      /RETURNING[\s\S]*token_digest/,
    );

    assert.match(
      sql,
      /\bCOMMIT\b/,
    );
  },
);

test(
  "email verification replay storage rejects a duplicate claim without fabricating success",
  async () => {
    const fake =
      fakePool(
        0,
      );

    const accepted =
      await claimEmailVerificationReplayToken(
        fake.pool,
        {
          userId:
            "user-1",
          tokenDigest:
            "b".repeat(64),
          acceptedAt:
            new Date(
              "2026-09-07T20:00:00.000Z",
            ),
          expiresAt:
            new Date(
              "2026-09-07T21:00:00.000Z",
            ),
        },
      );

    assert.equal(
      accepted,
      false,
    );
  },
);

test(
  "email verification replay migration stores no plaintext verification credential",
  async () => {
    const migration =
      await readFile(
        new URL(
          "../migrations/0005_email_verification_replay_guard.sql",
          import.meta.url,
        ),
        "utf8",
      );

    assert.match(
      migration,
      /CREATE TABLE app\.auth_email_verification_replay_guard/,
    );

    assert.match(
      migration,
      /REFERENCES auth\."user" \("id"\)[\s\S]*ON DELETE CASCADE/,
    );

    assert.match(
      migration,
      /PRIMARY KEY[\s\S]*user_id[\s\S]*token_digest/,
    );

    assert.match(
      migration,
      /expires_at > accepted_at/,
    );

    assert.doesNotMatch(
      migration,
      /^\s+(token|email)\s+TEXT\b/im,
    );
  },
);

test(
  "auth core wires replay protection before Better Auth verify-email handler",
  async () => {
    const core =
      await readFile(
        new URL(
          "../src/auth/core.ts",
          import.meta.url,
        ),
        "utf8",
      );

    const replay =
      await readFile(
        new URL(
          "../src/auth/email-verification-replay.ts",
          import.meta.url,
        ),
        "utf8",
      );

    assert.match(
      core,
      /createEmailVerificationReplayHook/,
    );

    assert.match(
      core,
      /hooks:\s*\{[\s\S]*before:[\s\S]*createEmailVerificationReplayHook/,
    );

    assert.match(
      replay,
      /ctx\.path\s*!==[\s\S]*"\/verify-email"/,
    );

    assert.match(
      replay,
      /!parsed\.isEmailChange[\s\S]*user\.emailVerified === true/,
    );

    assert.match(
      replay,
      /verifyJWT/,
    );

    assert.match(
      replay,
      /claimEmailVerificationReplayToken/,
    );

    assert.doesNotMatch(
      replay,
      /console\.(?:log|error|warn)\s*\(/,
    );
  },
);
