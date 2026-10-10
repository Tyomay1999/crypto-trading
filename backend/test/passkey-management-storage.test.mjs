import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(
  "src/storage/passkey-management.ts",
  "utf8",
);

function loadModule() {
  const module = { exports: {} };
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: "passkey-management.ts",
  }).outputText;
  vm.runInNewContext(output, {
    exports: module.exports,
    module,
    require(specifier) {
      throw new Error(
        `Unexpected management storage import: ${specifier}`,
      );
    },
    Date,
    Error,
    JSON,
    Map,
    Math,
    Number,
    Object,
    Set,
  });
  return module.exports;
}

const management = loadModule();
const plain = (value) =>
  JSON.parse(JSON.stringify(value));

const safeRow = (overrides = {}) => ({
  id: "synthetic-passkey-a",
  name: "Work key",
  createdAt: new Date(
    "2026-09-11T12:00:00.000Z",
  ),
  deviceType: "multiDevice",
  backedUp: true,
  credentialID:
    "CREDENTIAL_SECRET_SENTINEL",
  publicKey: "PUBLIC_KEY_SECRET_SENTINEL",
  counter: 17,
  aaguid: "AAGUID_SECRET_SENTINEL",
  transports: "TRANSPORT_SECRET_SENTINEL",
  userId: "USER_SECRET_SENTINEL",
  secretSentinel: "SECRET_SENTINEL",
  ...overrides,
});

function normalized(sql) {
  return sql.replace(/\s+/g, " ").trim();
}

function deleteHarness(options = {}) {
  const events = [];
  const calls = [];
  const state =
    options.state ?? {
      passkeys: new Set([
        "synthetic-passkey-a",
      ]),
    };
  const userId =
    options.userId ?? "synthetic-user";
  const client = {
    async query(sql, params = []) {
      const text = normalized(sql);
      calls.push({
        client,
        sql: text,
        params: [...params],
      });
      if (text === "BEGIN") {
        events.push("BEGIN");
        return { rowCount: null, rows: [] };
      }
      if (text === "COMMIT") {
        events.push("COMMIT");
        return { rowCount: null, rows: [] };
      }
      if (text === "ROLLBACK") {
        events.push("ROLLBACK");
        return { rowCount: null, rows: [] };
      }
      if (
        text.includes('FROM auth."user" AS u') &&
        text.includes("FOR UPDATE")
      ) {
        events.push("LOCK_USER");
        if (options.throwAt === "lock") {
          throw new Error("synthetic storage detail");
        }
        return options.userExists === false
          ? { rowCount: 0, rows: [] }
          : {
              rowCount: 1,
              rows: [{
                id: userId,
                emailVerified:
                  options.verified !== false,
              }],
            };
      }
      if (
        text.includes('SELECT p."id" AS "id"')
      ) {
        events.push("TARGET");
        const target = params[1];
        const owned =
          params[0] === userId &&
          state.passkeys.has(target) &&
          options.targetExists !== false;
        return owned
          ? {
              rowCount: 1,
              rows: [{ id: target }],
            }
          : { rowCount: 0, rows: [] };
      }
      if (
        text.includes("AS \"usablePassword\"")
      ) {
        events.push("PASSWORD");
        if (options.throwAt === "password") {
          throw new Error("synthetic storage detail");
        }
        return {
          rowCount: 1,
          rows: [{
            usablePassword:
              options.password === true,
          }],
        };
      }
      if (
        text.includes("AS \"otherPasskeyCount\"")
      ) {
        events.push("OTHER_PASSKEYS");
        if (options.throwAt === "other") {
          throw new Error("synthetic storage detail");
        }
        const count =
          [...state.passkeys].filter(
            (id) => id !== params[1],
          ).length;
        return {
          rowCount: 1,
          rows: [{
            otherPasskeyCount:
              options.otherCount ?? count,
          }],
        };
      }
      if (text.startsWith("DELETE FROM")) {
        events.push("DELETE");
        if (options.throwAt === "delete") {
          throw new Error("synthetic storage detail");
        }
        const target = params[1];
        const deleted =
          params[0] === userId &&
          state.passkeys.delete(target);
        return {
          rowCount:
            options.deleteCount ??
            (deleted ? 1 : 0),
          rows: [],
        };
      }
      throw new Error(
        `Unexpected synthetic query: ${text}`,
      );
    },
    release() {
      events.push("RELEASE");
    },
  };
  const database = {
    async connect() {
      events.push("CONNECT");
      return client;
    },
    async query() {
      throw new Error(
        "Pool query must not enter delete critical section.",
      );
    },
  };
  return {
    calls,
    client,
    database,
    events,
    state,
    userId,
  };
}

test("management storage exports only the narrow I4 API", () => {
  assert.deepEqual(
    Object.keys(management).sort(),
    [
      "PASSKEY_MANAGEMENT_NAME_MAX_LENGTH",
      "deleteOwnedPasskeyWithLastLoginGuard",
      "listPasskeysForUser",
      "renameOwnedPasskey",
    ],
  );
  assert.equal(
    management.PASSKEY_MANAGEMENT_NAME_MAX_LENGTH,
    64,
  );
});

test("list is user scoped, deterministically ordered, and safely projected", async () => {
  const calls = [];
  const database = {
    async query(sql, params) {
      calls.push({
        sql: normalized(sql),
        params: [...params],
      });
      return {
        rowCount: 1,
        rows: [safeRow()],
      };
    },
  };
  const result =
    await management.listPasskeysForUser(
      database,
      "synthetic-user-a",
    );
  assert.equal(result.status, "listed");
  assert.deepEqual(
    plain(result.passkeys),
    [{
      id: "synthetic-passkey-a",
      name: "Work key",
      createdAt:
        "2026-09-11T12:00:00.000Z",
      deviceType: "multiDevice",
      backedUp: true,
    }],
  );
  assert.deepEqual(
    calls[0].params,
    ["synthetic-user-a"],
  );
  assert.match(
    calls[0].sql,
    /WHERE p\."userId" = \$1/,
  );
  assert.match(
    calls[0].sql,
    /ORDER BY p\."createdAt" ASC NULLS LAST, p\."id" ASC/,
  );
  assert.equal(
    JSON.stringify(result).includes(
      "SECRET_SENTINEL",
    ),
    false,
  );
});

test("list accepts an empty owned inventory", async () => {
  const result =
    await management.listPasskeysForUser(
      {
        async query() {
          return { rowCount: 0, rows: [] };
        },
      },
      "synthetic-user-a",
    );
  assert.deepEqual(plain(result), {
    status: "listed",
    passkeys: [],
  });
});

test("list fails closed on malformed storage metadata", async () => {
  const result =
    await management.listPasskeysForUser(
      {
        async query() {
          return {
            rowCount: 1,
            rows: [safeRow({
              createdAt: null,
            })],
          };
        },
      },
      "synthetic-user-a",
    );
  assert.deepEqual(plain(result), {
    status: "unavailable",
  });
});

test("rename scopes by user and passkey and returns only the safe view", async () => {
  const calls = [];
  const result =
    await management.renameOwnedPasskey(
      {
        async query(sql, params) {
          calls.push({
            sql: normalized(sql),
            params: [...params],
          });
          return {
            rowCount: 1,
            rows: [safeRow({
              name: params[2],
            })],
          };
        },
      },
      {
        userId: "synthetic-user-a",
        passkeyId:
          "synthetic-passkey-a",
        name: "Renamed key",
      },
    );
  assert.equal(result.status, "renamed");
  assert.deepEqual(calls[0].params, [
    "synthetic-user-a",
    "synthetic-passkey-a",
    "Renamed key",
  ]);
  assert.match(
    calls[0].sql,
    /"userId" = \$1 AND "id" = \$2/,
  );
  assert.equal(
    JSON.stringify(result).includes(
      "SECRET_SENTINEL",
    ),
    false,
  );
});

test("rename maps missing and wrong-owner targets to the same result", async () => {
  for (const label of [
    "missing",
    "wrong-owner",
  ]) {
    const result =
      await management.renameOwnedPasskey(
        {
          async query() {
            return {
              rowCount: 0,
              rows: [{ detail: label }],
            };
          },
        },
        {
          userId: "synthetic-user-a",
          passkeyId: `synthetic-${label}`,
          name: "Renamed key",
        },
      );
    assert.deepEqual(plain(result), {
      status: "not_found",
    });
  }
});

test("rename preserves the accepted strict 64-character name policy", async () => {
  let queryCount = 0;
  const database = {
    async query() {
      queryCount += 1;
      return { rowCount: 0, rows: [] };
    },
  };
  for (const name of [
    "",
    " leading",
    "trailing ",
    "a".repeat(65),
    "control\nname",
  ]) {
    const result =
      await management.renameOwnedPasskey(
        database,
        {
          userId: "synthetic-user-a",
          passkeyId:
            "synthetic-passkey-a",
          name,
        },
      );
    assert.equal(
      result.status,
      "invalid_request",
    );
  }
  assert.equal(queryCount, 0);
});

test("delete permits the final passkey when a verified usable password exists", async () => {
  const harness = deleteHarness({
    password: true,
  });
  const result =
    await management
      .deleteOwnedPasskeyWithLastLoginGuard(
        harness.database,
        {
          userId: harness.userId,
          passkeyId:
            "synthetic-passkey-a",
        },
      );
  assert.deepEqual(plain(result), {
    status: "deleted",
  });
  assert.deepEqual(harness.events, [
    "CONNECT",
    "BEGIN",
    "LOCK_USER",
    "TARGET",
    "PASSWORD",
    "OTHER_PASSKEYS",
    "DELETE",
    "COMMIT",
    "RELEASE",
  ]);
});

test("delete permits one passkey when another owned passkey remains", async () => {
  const harness = deleteHarness({
    state: {
      passkeys: new Set(["a", "b"]),
    },
  });
  const result =
    await management
      .deleteOwnedPasskeyWithLastLoginGuard(
        harness.database,
        {
          userId: harness.userId,
          passkeyId: "a",
        },
      );
  assert.equal(result.status, "deleted");
  assert.deepEqual(
    [...harness.state.passkeys],
    ["b"],
  );
});

test("delete rejects the final passkey without a usable password", async () => {
  const harness = deleteHarness();
  const result =
    await management
      .deleteOwnedPasskeyWithLastLoginGuard(
        harness.database,
        {
          userId: harness.userId,
          passkeyId:
            "synthetic-passkey-a",
        },
      );
  assert.deepEqual(plain(result), {
    status:
      "last_login_method_required",
  });
  assert.equal(
    harness.events.includes("DELETE"),
    false,
  );
  assert.equal(
    harness.events.at(-2),
    "ROLLBACK",
  );
});

test("TOTP and recovery inventory never count as primary login methods", async () => {
  const harness = deleteHarness({
    totpActive: true,
    recoveryCodes: 10,
  });
  const result =
    await management
      .deleteOwnedPasskeyWithLastLoginGuard(
        harness.database,
        {
          userId: harness.userId,
          passkeyId:
            "synthetic-passkey-a",
        },
      );
  assert.equal(
    result.status,
    "last_login_method_required",
  );
  assert.doesNotMatch(
    source,
    /auth\."twoFactor"|recovery_code|recoveryCode/,
  );
});

test("unverified or unusable password state cannot authorize final deletion", async () => {
  for (const options of [
    { verified: false, password: true },
    { verified: true, password: false },
  ]) {
    const harness = deleteHarness(options);
    const result =
      await management
        .deleteOwnedPasskeyWithLastLoginGuard(
          harness.database,
          {
            userId: harness.userId,
            passkeyId:
              "synthetic-passkey-a",
          },
        );
    assert.equal(
      result.status,
      "last_login_method_required",
    );
  }
  assert.match(
    source,
    /"emailVerified"/,
  );
  assert.match(
    source,
    /"providerId" = 'credential'/,
  );
  assert.match(
    source,
    /length\(a\."password"\) > 0/,
  );
});

test("target ownership is rechecked after acquiring the user lock", async () => {
  const harness = deleteHarness({
    targetExists: false,
    password: true,
  });
  const result =
    await management
      .deleteOwnedPasskeyWithLastLoginGuard(
        harness.database,
        {
          userId: harness.userId,
          passkeyId:
            "synthetic-passkey-a",
        },
      );
  assert.equal(result.status, "not_found");
  assert.deepEqual(
    harness.events.slice(1, 5),
    [
      "BEGIN",
      "LOCK_USER",
      "TARGET",
      "ROLLBACK",
    ],
  );
  assert.equal(
    harness.events.includes("DELETE"),
    false,
  );
});

test("an absent authoritative user fails closed before guard reads", async () => {
  const harness = deleteHarness({
    userExists: false,
  });
  const result =
    await management
      .deleteOwnedPasskeyWithLastLoginGuard(
        harness.database,
        {
          userId: harness.userId,
          passkeyId:
            "synthetic-passkey-a",
        },
      );
  assert.equal(result.status, "unavailable");
  assert.deepEqual(harness.events, [
    "CONNECT",
    "BEGIN",
    "LOCK_USER",
    "ROLLBACK",
    "RELEASE",
  ]);
});

test("delete critical section uses one transaction client and parameterized SQL", async () => {
  const hostileUser =
    "user' OR '1'='1";
  const hostilePasskey =
    "key'; DELETE FROM auth.user --";
  const harness = deleteHarness({
    userId: hostileUser,
    password: true,
    state: {
      passkeys: new Set([hostilePasskey]),
    },
  });
  const result =
    await management
      .deleteOwnedPasskeyWithLastLoginGuard(
        harness.database,
        {
          userId: hostileUser,
          passkeyId: hostilePasskey,
        },
      );
  assert.equal(result.status, "deleted");
  for (const call of harness.calls) {
    assert.equal(call.client, harness.client);
    if (call.params.length > 0) {
      assert.equal(
        call.sql.includes(hostileUser),
        false,
      );
      assert.equal(
        call.sql.includes(hostilePasskey),
        false,
      );
    }
  }
  assert.match(
    harness.calls.find((call) =>
      call.sql.includes("FOR UPDATE"),
    ).sql,
    /WHERE u\."id" = \$1 FOR UPDATE/,
  );
});

test("rename keeps hostile input in parameters rather than SQL", async () => {
  const hostileName =
    "key', password = 'unsafe";
  const calls = [];
  await management.renameOwnedPasskey(
    {
      async query(sql, params) {
        calls.push({
          sql: normalized(sql),
          params: [...params],
        });
        return {
          rowCount: 1,
          rows: [safeRow({
            name: params[2],
          })],
        };
      },
    },
    {
      userId: "synthetic-user",
      passkeyId: "synthetic-passkey",
      name: hostileName,
    },
  );
  assert.equal(
    calls[0].sql.includes(hostileName),
    false,
  );
  assert.equal(calls[0].params[2], hostileName);
});

test("serialized re-evaluation closes the two-passkey double-delete contract", async () => {
  const state = {
    passkeys: new Set(["a", "b"]),
  };
  const first = deleteHarness({ state });
  const firstResult =
    await management
      .deleteOwnedPasskeyWithLastLoginGuard(
        first.database,
        {
          userId: first.userId,
          passkeyId: "a",
        },
      );
  const second = deleteHarness({ state });
  const secondResult =
    await management
      .deleteOwnedPasskeyWithLastLoginGuard(
        second.database,
        {
          userId: second.userId,
          passkeyId: "b",
        },
      );
  assert.equal(firstResult.status, "deleted");
  assert.equal(
    secondResult.status,
    "last_login_method_required",
  );
  assert.deepEqual([...state.passkeys], ["b"]);
  assert.ok(
    second.events.indexOf("LOCK_USER") <
      second.events.indexOf("OTHER_PASSKEYS"),
  );
});

test("storage failure rolls back and returns only finite unavailable state", async () => {
  const harness = deleteHarness({
    throwAt: "other",
  });
  const result =
    await management
      .deleteOwnedPasskeyWithLastLoginGuard(
        harness.database,
        {
          userId: harness.userId,
          passkeyId:
            "synthetic-passkey-a",
        },
      );
  assert.deepEqual(plain(result), {
    status: "unavailable",
  });
  assert.equal(
    harness.events.includes("ROLLBACK"),
    true,
  );
  assert.equal(
    harness.events.includes("DELETE"),
    false,
  );
});

test("I4 storage contains no HTTP, fresh-proof, ceremony, session, or cookie wiring", () => {
  assert.doesNotMatch(
    source,
    /from "express"|passkey\.routes|require-session|require-trusted-origin|passkey-errors/,
  );
  assert.doesNotMatch(
    source,
    /verifyPassword|totpCode|issueChallenge|createSession|writeProvenance|setCookie|Set-Cookie/,
  );
  assert.doesNotMatch(
    source,
    /assuranceLevel|trustedDevice|stepUpSatisfied/,
  );
  assert.match(
    source,
    /type CurrentPrimaryLoginMethod =\s*\| "password"\s*\| "passkey"/,
  );
});
