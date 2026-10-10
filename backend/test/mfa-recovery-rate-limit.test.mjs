import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  RECOVERY_LIMITS,
  RECOVERY_RATE_LIMIT_IDENTIFIER_BITS,
  recoveryBucketId,
  takeRecoveryRateLimit,
} from "../dist/storage/recovery-rate-limit.js";
import { recoveryIpRateLimit } from "../dist/middleware/recovery-rate-limit.js";

const pepper = "recovery-limiter-pepper-01234567890123456789";

test("limiter retains a full keyed 256-bit identity with domain separation", () => {
  const source = "203.0.113.45";
  const first = recoveryBucketId(pepper, "challengeIp", source);

  assert.equal(RECOVERY_RATE_LIMIT_IDENTIFIER_BITS, 256);
  assert.ok(RECOVERY_RATE_LIMIT_IDENTIFIER_BITS >= 128);
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(Buffer.from(first, "hex").length, 32);
  assert.equal(first.includes(source), false);
  assert.equal(first, recoveryBucketId(pepper, "challengeIp", source));
  assert.notEqual(first, recoveryBucketId(pepper, "statusIp", source));
  assert.notEqual(
    recoveryBucketId(pepper, "mutationIp", source),
    recoveryBucketId(pepper, "mutationUser", source),
  );
  assert.notEqual(first, recoveryBucketId(pepper + "x", "challengeIp", source));

  const implementation = readFileSync(
    "src/storage/recovery-rate-limit.ts",
    "utf8",
  );
  assert.match(implementation, /\.digest\("hex"\)/);
  assert.doesNotMatch(implementation, /readUInt16|subarray\(|\.slice\(/);
});

test("known rejected-shard collision clients retain different exact bucket IDs", async () => {
  const regressionPepper = "audit-regression-pepper-0123456789-122444";
  const clients = ["client-190", "client-310"];
  const rejectedShard = (source) =>
    createHmac("sha256", regressionPepper)
      .update(
        JSON.stringify([
          "delta:recovery-limit:source:v1",
          "challengeIp",
          source,
        ]),
      )
      .digest()
      .readUInt16BE(0);

  assert.equal(rejectedShard(clients[0]), rejectedShard(clients[1]));
  const fullIds = clients.map((source) =>
    recoveryBucketId(regressionPepper, "challengeIp", source),
  );
  assert.notEqual(fullIds[0], fullIds[1]);

  const hits = new Map();
  const persistedIds = [];
  const database = {
    async query(sql, values = []) {
      if (!/RETURNING id/.test(sql)) return { rowCount: 0, rows: [] };
      const id = values[0];
      persistedIds.push(id);
      const next = (hits.get(id) ?? 0) + 1;
      if (next > values[2]) return { rowCount: 0, rows: [] };
      hits.set(id, next);
      return { rowCount: 1, rows: [{ id }] };
    },
  };

  for (const client of clients) {
    for (
      let attempt = 0;
      attempt < RECOVERY_LIMITS.challengeIp.limit;
      attempt++
    )
      assert.equal(
        await takeRecoveryRateLimit(
          database,
          regressionPepper,
          "challengeIp",
          client,
        ),
        true,
      );
    assert.equal(
      await takeRecoveryRateLimit(
        database,
        regressionPepper,
        "challengeIp",
        client,
      ),
      false,
    );
  }
  assert.deepEqual(new Set(persistedIds), new Set(fullIds));
  assert.equal(
    persistedIds.some((id) => clients.includes(id)),
    false,
  );
});

test("limiter input validation is bounded and rejects malformed identities", () => {
  for (const [badPepper, badScope, badSource] of [
    ["short", "challengeIp", "client"],
    [pepper, "unknown", "client"],
    [pepper, "challengeIp", ""],
    [pepper, "challengeIp", "x".repeat(257)],
  ]) {
    assert.throws(() => recoveryBucketId(badPepper, badScope, badSource));
  }
});

test("durable limiter uses atomic bounded UPSERT and bounded expired-row cleanup", async () => {
  const calls = [];
  const database = {
    async query(sql, values = []) {
      calls.push({ sql, values });
      return {
        rowCount: /RETURNING id/.test(sql) ? 1 : 0,
        rows: [],
      };
    },
  };

  assert.equal(
    await takeRecoveryRateLimit(
      database,
      pepper,
      "challengeIp",
      "198.51.100.10",
    ),
    true,
  );

  assert.equal(calls.length, 2);
  assert.match(calls[0].sql, /LIMIT 64/);
  assert.match(calls[0].sql, /expires_at <= clock_timestamp\(\)/);
  assert.match(calls[1].sql, /ON CONFLICT \(id\) DO UPDATE/);
  assert.match(calls[1].sql, /hits < \$3/);
  assert.deepEqual(calls[1].values.slice(1), [
    RECOVERY_LIMITS.challengeIp.seconds,
    RECOVERY_LIMITS.challengeIp.limit,
  ]);
  assert.match(calls[1].values[0], /^[a-f0-9]{64}$/);
  assert.equal(calls[1].values.includes("198.51.100.10"), false);
});

test("migration makes the full 64-hex identity the exact primary key", () => {
  const sql = readFileSync("migrations/0006_mfa_recovery_codes.sql", "utf8");
  assert.match(
    sql,
    /id TEXT PRIMARY KEY CHECK \(id ~ '\^\[0-9a-f\]\{64\}\$'\)/,
  );
  assert.match(sql, /auth_recovery_rate_limit_expiry_idx/);
});

test("limiter rejection and storage failures fail closed", async () => {
  assert.equal(
    await takeRecoveryRateLimit(
      {
        async query(sql) {
          return {
            rowCount: /RETURNING id/.test(sql) ? 0 : 1,
            rows: [],
          };
        },
      },
      pepper,
      "mutationUser",
      "user-a",
    ),
    false,
  );

  await assert.rejects(
    takeRecoveryRateLimit(
      {
        async query() {
          throw new Error("sensitive driver message");
        },
      },
      pepper,
      "statusIp",
      "192.0.2.1",
    ),
    (error) => error.message === "Recovery rate-limit storage unavailable.",
  );
});

test("IP middleware accepts only the trusted single-IP boundary and hashes it before storage", async () => {
  const calls = [];
  const database = {
    async query(sql, values = []) {
      calls.push({ sql, values });
      return {
        rowCount: /RETURNING id/.test(sql) ? 1 : 0,
        rows: [],
      };
    },
  };
  const middleware = recoveryIpRateLimit(database, pepper, "challengeIp");
  let advanced = false;

  await middleware(
    {
      get(name) {
        return name === "x-real-ip" ? "2001:db8::1" : undefined;
      },
    },
    {},
    () => {
      advanced = true;
    },
  );

  assert.equal(advanced, true);
  assert.equal(
    calls.some((call) => call.values.includes("2001:db8::1")),
    false,
  );

  for (const invalid of [
    undefined,
    "203.0.113.1, 198.51.100.1",
    "attacker.example",
  ]) {
    await assert.rejects(
      middleware(
        {
          get() {
            return invalid;
          },
        },
        {},
        () => {},
      ),
    );
  }
});
