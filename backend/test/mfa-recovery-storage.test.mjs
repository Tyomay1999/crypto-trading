import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

import { symmetricDecrypt } from "better-auth/crypto";
import { createOTP } from "@better-auth/utils/otp";

import { createTotpReplacementMaterial } from "../dist/auth/totp-replacement.js";
import {
  claimRecoveryManagementProof,
  recoveryStatus,
  replaceRecoveryCodes,
} from "../dist/storage/recovery-codes.js";

const encryptionKey = "management-encryption-key-01234567890123456789";

const recoveryPepper = "recovery-storage-pepper-01234567890123456789";

async function managementCredential() {
  const material = await createTotpReplacementMaterial(encryptionKey);

  const secret = await symmetricDecrypt({
    key: encryptionKey,
    data: material.encryptedSecret,
  });

  const code = await createOTP(secret, {
    digits: 6,
    period: 30,
  }).totp();

  return {
    code,
    encryptedSecret: material.encryptedSecret,
  };
}

function proofDatabase(encryptedSecret, replayRowCount = 1) {
  const calls = [];

  const client = {
    async query(sql, values = []) {
      calls.push({ sql, values });

      if (/FROM auth\."user"/.test(sql)) {
        return {
          rowCount: 1,
          rows: [{ id: "user-a" }],
        };
      }

      if (/FROM auth\."twoFactor"/.test(sql)) {
        return {
          rowCount: 1,
          rows: [
            {
              id: "factor-a",
              secret: encryptedSecret,
              lockedUntil: null,
            },
          ],
        };
      }

      if (/FROM auth\."session"/.test(sql)) {
        return {
          rowCount: 1,
          rows: [{ id: "session-a" }],
        };
      }

      if (/FROM auth\."account"/.test(sql)) {
        return {
          rowCount: 1,
          rows: [
            {
              id: "account-a",
              password: "stored-password-hash",
            },
          ],
        };
      }

      if (/INSERT INTO app\.auth_totp_replay_guard/.test(sql)) {
        return {
          rowCount: replayRowCount,
          rows: [],
        };
      }

      return {
        rowCount: 0,
        rows: [],
      };
    },

    release() {
      calls.push({ sql: "RELEASE", values: [] });
    },
  };

  return {
    calls,
    database: {
      connect: async () => client,
    },
  };
}

test("management proof requires password, active TOTP, live session and a durable replay claim", async () => {
  const credential = await managementCredential();

  const fake = proofDatabase(credential.encryptedSecret);

  const proof = await claimRecoveryManagementProof(
    fake.database,
    {
      userId: "user-a",
      sessionId: "session-a",
      password: "current-password",
      code: credential.code,
      encryptionKey,
      replayPepper: "totp-replay-pepper-01234567890123456789",
    },
    async ({ hash, password }) =>
      hash === "stored-password-hash" && password === "current-password",
  );

  assert.ok(proof);
  assert.equal(fake.calls[0].sql, "BEGIN");
  assert.ok(
    fake.calls.some(
      (call) =>
        /INSERT INTO app\.auth_totp_replay_guard/.test(call.sql) &&
        /ON CONFLICT \(user_id, code_digest\) DO NOTHING/.test(call.sql),
    ),
  );
  assert.equal(fake.calls.at(-2).sql, "COMMIT");

  for (const call of fake.calls) {
    assert.doesNotMatch(
      call.sql,
      /current-password|stored-password-hash|\d{6}/,
    );
  }
});

test("a replayed management TOTP proof remains consumed and returns no proof", async () => {
  const credential = await managementCredential();
  const fake = proofDatabase(credential.encryptedSecret, 0);

  assert.equal(
    await claimRecoveryManagementProof(
      fake.database,
      {
        userId: "user-a",
        sessionId: "session-a",
        password: "current-password",
        code: credential.code,
        encryptionKey,
        replayPepper: "totp-replay-pepper-01234567890123456789",
      },
      async () => true,
    ),
    null,
  );

  assert.equal(fake.calls.at(-2).sql, "COMMIT");
});

test("status counts by stable set identity across a regeneration observation", async () => {
  const calls = [];
  const adapter = {
    async findOne({ model }) {
      assert.equal(model, "recoveryCodeSet");
      return {
        id: "stable-set-a",
        userId: "user-a",
        generation: "old-generation",
      };
    },
    async count({ model, where }) {
      calls.push({ model, where });
      // Model a regeneration committed after findOne: only the stable set ID
      // identifies the ten rows in the now-current generation.
      return where.some((entry) => entry.field === "generation") ? 0 : 10;
    },
  };

  assert.deepEqual(await recoveryStatus(adapter, "user-a"), {
    configured: true,
    remaining: 10,
  });
  assert.deepEqual(calls, [
    {
      model: "recoveryCode",
      where: [{ field: "setId", value: "stable-set-a" }],
    },
  ]);
});

function recoverySetHarness(encryptedSecret) {
  let state = {
    generation: null,
    codes: [],
  };
  const events = [];

  const transactionAdapter = {
    async findOne({ model }) {
      if (model === "recoveryCodeSet" && state.generation) {
        return {
          id: "set-a",
          userId: "user-a",
          generation: state.generation,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
      }

      return null;
    },

    async incrementOne({ model, where, set }) {
      events.push(`lock:${model}`);

      if (model === "user") {
        return {
          id: "user-a",
          twoFactorEnabled: true,
        };
      }

      if (model === "twoFactor") {
        return {
          id: "factor-a",
          userId: "user-a",
          secret: encryptedSecret,
          verified: true,
          failedVerificationCount: 0,
          lockedUntil: null,
        };
      }

      if (model === "session") {
        return {
          id: "session-a",
          expiresAt: new Date("2100-01-01T00:00:00.000Z"),
        };
      }

      if (model === "account") {
        return { id: "account-a" };
      }

      if (model === "recoveryCodeSet") {
        const expected = where.find(
          (entry) => entry.field === "generation",
        )?.value;

        if (state.generation !== expected) {
          return null;
        }

        if (set.generation !== expected) {
          state.generation = set.generation;
        }

        return {
          id: "set-a",
          userId: "user-a",
          generation: state.generation,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
      }

      return null;
    },

    async create({ model, data }) {
      events.push(`create:${model}`);

      if (model === "recoveryCodeSet") {
        state.generation = data.generation;

        return {
          id: "set-a",
          userId: data.userId,
          ...data,
        };
      }

      if (model === "recoveryCode") {
        state.codes.push(data);
        return { id: `code-${state.codes.length}` };
      }

      return {};
    },

    async deleteMany({ model }) {
      events.push(`delete:${model}`);
      state.codes = [];
      return 0;
    },
  };

  const adapter = {
    id: "storage-test",

    async transaction(callback) {
      const snapshot = structuredClone(state);

      events.push("transaction:begin");

      try {
        const result = await callback(transactionAdapter);

        events.push("transaction:commit");
        return result;
      } catch (error) {
        state = snapshot;
        events.push("transaction:rollback");
        throw error;
      }
    },
  };

  return {
    adapter,
    events,
    get state() {
      return state;
    },
  };
}

test("initial generation persists only ten binary digests after serialized security proof", async () => {
  const credential = await managementCredential();
  const harness = recoverySetHarness(credential.encryptedSecret);
  const proof = {
    userId: "user-a",
    sessionId: "session-a",
    factorId: "factor-a",
    encryptedSecret: credential.encryptedSecret,
    accountId: "account-a",
    passwordHash: "stored-password-hash",
    acceptedAt: new Date(),
  };

  const result = await replaceRecoveryCodes(
    harness.adapter,
    proof,
    null,
    recoveryPepper,
    {
      encryptionKey,
      code: credential.code,
    },
  );

  assert.equal(result.codes.length, 10);
  assert.equal(harness.state.codes.length, 10);
  assert.equal(
    new Set(harness.state.codes.map((row) => row.codeDigest)).size,
    10,
  );

  for (const row of harness.state.codes) {
    assert.deepEqual(Object.keys(row).sort(), [
      "codeDigest",
      "generation",
      "setId",
    ]);
    assert.match(row.codeDigest, /^\\x[a-f0-9]{64}$/);
    assert.equal(result.codes.includes(row.codeDigest), false);
  }

  assert.deepEqual(harness.events.slice(1, 5), [
    "lock:user",
    "lock:twoFactor",
    "lock:session",
    "lock:account",
  ]);
  assert.equal(harness.events.at(-1), "transaction:commit");
});

test("regeneration deletes the old set contents and same-generation racers cannot both report success", async () => {
  const credential = await managementCredential();
  const harness = recoverySetHarness(credential.encryptedSecret);
  const proof = {
    userId: "user-a",
    sessionId: "session-a",
    factorId: "factor-a",
    encryptedSecret: credential.encryptedSecret,
    accountId: "account-a",
    passwordHash: "stored-password-hash",
    acceptedAt: new Date(),
  };

  const first = await replaceRecoveryCodes(
    harness.adapter,
    proof,
    null,
    recoveryPepper,
    {
      encryptionKey,
      code: credential.code,
    },
  );
  const expected = harness.state.generation;
  const oldCodes = new Set(first.codes);

  const winner = await replaceRecoveryCodes(
    harness.adapter,
    proof,
    expected,
    recoveryPepper,
    {
      encryptionKey,
      code: credential.code,
    },
  );
  const loser = await replaceRecoveryCodes(
    harness.adapter,
    proof,
    expected,
    recoveryPepper,
    {
      encryptionKey,
      code: credential.code,
    },
  );

  assert.equal(winner.codes.length, 10);
  assert.equal(loser, null);
  assert.equal(
    winner.codes.some((value) => oldCodes.has(value)),
    false,
  );
  assert.ok(harness.events.includes("delete:recoveryCode"));
});

test("migration 0006 contains only hash-only recovery state and cascading provenance", () => {
  const sql = readFileSync("migrations/0006_mfa_recovery_codes.sql", "utf8");

  for (const table of [
    "auth_recovery_code_set",
    "auth_recovery_code",
    "auth_recovery_session_marker",
    "auth_recovery_rate_limit",
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE app\\.${table}`));
  }

  assert.match(
    sql,
    /code_digest BYTEA NOT NULL CHECK \(octet_length\(code_digest\) = 32\)/,
  );
  assert.match(
    sql,
    /session_id TEXT NOT NULL UNIQUE REFERENCES auth\."session"\("id"\) ON DELETE CASCADE/,
  );
  assert.match(
    sql,
    /user_id TEXT NOT NULL UNIQUE REFERENCES auth\."user"\("id"\) ON DELETE CASCADE/,
  );
  assert.doesNotMatch(
    sql,
    /plaintext|encrypted_code|code_hint|code_prefix|recovery_blob/i,
  );
});

test("migration 0006 and accepted predecessors remain fixed without capping later migrations", () => {
  const migrations = readdirSync("migrations")
    .filter((value) => /^\d{4}_.+\.sql$/.test(value))
    .sort();

  assert.deepEqual(
    migrations.slice(0, 6).map((value) => value.slice(0, 4)),
    ["0001", "0002", "0003", "0004", "0005", "0006"],
  );
  assert.equal(migrations[5], "0006_mfa_recovery_codes.sql");

  const sha256 = (file) =>
    createHash("sha256").update(readFileSync(file)).digest("hex");

  assert.equal(
    sha256("migrations/0004_mfa_totp_foundation.sql"),
    "58801e80404e504831175eef9068116b8a64dba1a0ab9ab711316ce0820837d6",
  );
  assert.equal(
    sha256("migrations/0005_email_verification_replay_guard.sql"),
    "96e889862713483925ef8c0fd209ac8b6472e1afe6bfbf403d0c1e1df043b106",
  );
});
