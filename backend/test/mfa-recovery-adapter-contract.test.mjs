import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Kysely, PostgresDialect } from "kysely";
import { kyselyAdapter } from "@better-auth/kysely-adapter";
import {
  getCurrentAdapter,
  runWithTransaction,
} from "@better-auth/core/context";
import { createInternalAdapter } from "better-auth/db";
import { recoverySchema } from "../dist/auth/recovery-code-plugin.js";

const read = (path) => readFileSync(path, "utf8");
test("exact direct dependency pins and required public exports", async () => {
  const pkg = JSON.parse(read("package.json")),
    lock = JSON.parse(read("package-lock.json"));
  for (const name of ["better-auth", "@better-auth/core"]) {
    assert.equal(pkg.dependencies[name], "1.7.3");
    assert.equal(lock.packages[""].dependencies[name], "1.7.3");
    assert.equal(lock.packages["node_modules/" + name].version, "1.7.3");
    assert.equal(
      JSON.parse(read("node_modules/" + name + "/package.json")).version,
      "1.7.3",
    );
  }
  for (const [path, names] of [
    ["better-auth/api", ["createAuthEndpoint", "getSessionFromCtx"]],
    ["better-auth/cookies", ["setSessionCookie", "expireCookie"]],
    ["@better-auth/core/context", ["runWithTransaction", "getCurrentAdapter"]],
  ]) {
    const exports = await import(path);
    for (const name of names) assert.equal(typeof exports[name], "function");
  }
});
test("installed PostgreSQL adapter emits real transaction, native guarded writes and BYTEA parameters", async () => {
  const queries = [];
  const client = {
    async query(sql, parameters) {
      queries.push({ sql, parameters });
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  const db = new Kysely({
    dialect: new PostgresDialect({
      pool: { connect: async () => client, end: async () => {} },
    }),
  });
  const options = {
    advanced: { database: { validateSchema: false } },
    plugins: [{ id: "delta-probe", schema: recoverySchema }],
    verification: { storeIdentifier: "hashed" },
  };
  const adapter = kyselyAdapter(db, { type: "postgres", transaction: true })(
    options,
  );
  const internal = createInternalAdapter(adapter, {
    options,
    hooks: [],
    logger: { error() {} },
  });
  try {
    await runWithTransaction(adapter, async () => {
      const tx = await getCurrentAdapter(adapter);
      assert.notEqual(tx, adapter);
      await tx.create({
        model: "recoveryCode",
        data: {
          setId: "s",
          generation: "g",
          codeDigest: "\\x" + "ab".repeat(32),
        },
      });
      await tx.consumeOne({
        model: "recoveryCode",
        where: [{ field: "codeDigest", value: "\\x" + "ab".repeat(32) }],
      });
      await tx.incrementOne({
        model: "recoveryCodeSet",
        where: [
          { field: "id", value: "s" },
          { field: "generation", value: "g" },
        ],
        increment: {},
        set: { generation: "g" },
      });
      await internal.createSession("synthetic-user", false);
      await internal.createVerificationValue({
        identifier: "2fa-attempts-2fa-synthetic",
        value: "1",
        expiresAt: new Date(Date.now() + 60000),
      });
    });
    assert.equal(queries[0].sql, "begin");
    assert.equal(queries.at(-1).sql, "commit");
    assert.equal(queries.filter((q) => q.sql === "begin").length, 1);
    assert.ok(queries.some((q) => /insert into "session"/.test(q.sql)));
    assert.ok(queries.some((q) => /insert into "verification"/.test(q.sql)));
    assert.ok(
      queries.some(
        (q) =>
          /insert into "app"\."auth_recovery_code"/.test(q.sql) &&
          q.parameters.includes("\\x" + "ab".repeat(32)),
      ),
    );
    assert.ok(
      queries.some(
        (q) =>
          /delete from "app"\."auth_recovery_code"/.test(q.sql) &&
          q.parameters.includes("\\x" + "ab".repeat(32)),
      ),
    );
    const guarded = queries.find((q) => /^update /.test(q.sql));
    assert.match(guarded.sql, /where.*generation.*returning \*/);
    await assert.rejects(
      runWithTransaction(adapter, async () => {
        throw new Error("synthetic rollback");
      }),
    );
    assert.equal(queries.at(-1).sql, "rollback");
  } finally {
    await db.destroy();
  }
});
test("installed verification protocol, cookie timing and migration ownership are pinned", () => {
  const helper = read(
    "node_modules/better-auth/dist/plugins/two-factor/verify-two-factor.mjs",
  );
  assert.match(helper, /`2fa-attempts-\$\{signedTwoFactorCookie\}`/);
  assert.match(helper, /consumeVerificationValue\(identifier\)/);
  assert.match(
    read("node_modules/better-auth/dist/plugins/two-factor/totp/index.mjs"),
    /beginAttempt\(5\)/,
  );
  assert.match(
    read("node_modules/better-auth/dist/plugins/two-factor/constant.mjs"),
    /TWO_FACTOR_COOKIE_NAME = "two_factor"/,
  );
  assert.match(
    read("node_modules/@better-auth/kysely-adapter/dist/index.mjs"),
    /new PostgresDialect\(\{ pool: db \}\);\s*transaction = true/,
  );
  assert.match(
    read("node_modules/@better-auth/core/dist/db/get-tables.mjs"),
    /disableMigrations: value.disableMigration/,
  );
  assert.match(
    read("node_modules/better-auth/dist/db/with-hooks.mjs"),
    /getCurrentAdapter\(adapter\)\)\.create/,
  );
  for (const schema of Object.values(recoverySchema))
    assert.equal(schema.disableMigration, true);
  const source = read("src/auth/recovery-challenge.ts");
  assert.ok(
    source.indexOf("await setSessionCookie") >
      source.indexOf('if (!result) return "rejected"'),
  );
  assert.doesNotMatch(source, /trustDevice|trust_device|INSERT INTO/);
  const core = read("src/auth/core.ts");
  for (const suffix of ["status", "generate", "regenerate", "verify"])
    assert.ok(core.includes('"/delta-recovery/' + suffix + '"'));
  assert.match(core, /customBackupCodesGenerate:\s*\(\) => \[\]/);
  for (const route of ["verify-backup-code", "generate-backup-codes"])
    assert.ok(core.includes('"/two-factor/' + route + '"'));
});
