import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const read = (path) => readFileSync(path, "utf8");
const sql = read("migrations/0007_webauthn_passkey_foundation.sql");
const schemaSource = read("src/auth/passkey-schema.ts");
const markerSource = read("src/storage/passkey-session-marker.ts");
const limiterSource = read("src/storage/passkey-rate-limit.ts");

const section = (start, end) => {
  const from = sql.indexOf(start);
  const to = sql.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `missing SQL section: ${start}`);
  assert.notEqual(to, -1, `missing SQL section terminator: ${end}`);
  return sql.slice(from, to);
};

const passkeyTable = section(
  'CREATE TABLE auth."passkey"',
  'CREATE INDEX "passkey_userId_idx"',
);
const markerTable = section(
  "CREATE TABLE app.auth_passkey_session_marker",
  "CREATE TABLE app.auth_passkey_rate_limit",
);
const limiterTable = section(
  "CREATE TABLE app.auth_passkey_rate_limit",
  "CREATE INDEX auth_passkey_rate_limit_expiry_idx",
);

test("migrations 0001 through 0006 retain their accepted bytes", () => {
  const expected = new Map([
    ["0001_foundation.sql", "3db84bed52dd1deea3a3e192511962f42f855701bf881c45be8c73a5cf4e4890"],
    ["0002_auth_core.sql", "fd4c7c6420c7057e179e58009f4a2c4982f7c8c1221aca1b726d474b52b7a80c"],
    ["0003_session_management.sql", "15397ed53138b2a2c64d097cc0507d91ad9a30f69910973cf5f14169a59c913f"],
    ["0004_mfa_totp_foundation.sql", "58801e80404e504831175eef9068116b8a64dba1a0ab9ab711316ce0820837d6"],
    ["0005_email_verification_replay_guard.sql", "96e889862713483925ef8c0fd209ac8b6472e1afe6bfbf403d0c1e1df043b106"],
    ["0006_mfa_recovery_codes.sql", "a7a1fc00361b56b98b60e518192635ffa24858ded64243c515c40e02eea5bc15"],
  ]);

  for (const [name, digest] of expected) {
    assert.equal(
      createHash("sha256").update(readFileSync(`migrations/${name}`)).digest("hex"),
      digest,
    );
  }
});

test("migration creates the exact Better Auth-compatible passkey model", () => {
  for (const field of [
    '"id" TEXT PRIMARY KEY',
    '"name" TEXT',
    '"publicKey" TEXT NOT NULL',
    '"userId" TEXT NOT NULL',
    '"credentialID" TEXT NOT NULL',
    '"counter" BIGINT NOT NULL',
    '"deviceType" TEXT NOT NULL',
    '"backedUp" BOOLEAN NOT NULL',
    '"transports" TEXT',
    '"createdAt" TIMESTAMPTZ',
    '"aaguid" TEXT',
  ]) {
    assert.ok(passkeyTable.includes(field), `missing passkey field: ${field}`);
  }

  assert.match(passkeyTable, /REFERENCES auth\."user" \("id"\)\s+ON DELETE CASCADE/);
  assert.match(passkeyTable, /CHECK \(length\("publicKey"\) > 0\)/);
  assert.match(sql, /CREATE INDEX "passkey_userId_idx"\s+ON auth\."passkey" \("userId"\)/);
});

test("credential IDs are globally unique canonical unpadded base64url text", () => {
  assert.match(passkeyTable, /UNIQUE \("credentialID"\)/);
  assert.match(
    passkeyTable,
    /CHECK \("credentialID" ~ '\^\[A-Za-z0-9_-\]\+\$'\)/,
  );
  assert.doesNotMatch(passkeyTable, /UNIQUE \("userId",\s*"credentialID"\)/);
  assert.doesNotMatch(passkeyTable, /lower\s*\(\s*"credentialID"/i);
});

test("passkey counter is BIGINT constrained to the full uint32 domain", () => {
  assert.match(passkeyTable, /"counter" BIGINT NOT NULL/);
  assert.match(passkeyTable, /CHECK \("counter" BETWEEN 0 AND 4294967295\)/);
  assert.doesNotMatch(passkeyTable, /"counter"\s+INTEGER/i);
  assert.doesNotMatch(passkeyTable, /"counter"[^,]*DEFAULT/i);
});

test("device metadata is constrained without becoming assurance", () => {
  assert.match(
    passkeyTable,
    /CHECK \("deviceType" IN \('singleDevice', 'multiDevice'\)\)/,
  );
  assert.match(passkeyTable, /"backedUp" BOOLEAN NOT NULL/);
  assert.doesNotMatch(passkeyTable, /assurance_level|trusted_device|preferred_login|preferred_step_up/i);
});

test("session marker retains method context with intentional FK lifetimes", () => {
  assert.match(markerTable, /session_id TEXT NOT NULL UNIQUE[\s\S]*REFERENCES auth\."session" \("id"\)[\s\S]*ON DELETE CASCADE/);
  assert.match(markerTable, /passkey_id TEXT[\s\S]*REFERENCES auth\."passkey" \("id"\)[\s\S]*ON DELETE SET NULL/);
  assert.doesNotMatch(markerTable, /passkey_id TEXT NOT NULL/);
  assert.match(markerTable, /CHECK \(user_verified = TRUE\)/);
  assert.match(markerTable, /credential_device_type TEXT NOT NULL[\s\S]*CHECK \(credential_device_type IN \('singleDevice', 'multiDevice'\)\)/);
  assert.match(markerTable, /credential_backed_up BOOLEAN NOT NULL/);
  assert.match(markerTable, /authenticated_at TIMESTAMPTZ NOT NULL/);
});

test("durable passkey limiter stores only a full keyed digest and bounded hits", () => {
  assert.match(limiterTable, /id TEXT PRIMARY KEY CHECK \(id ~ '\^\[0-9a-f\]\{64\}\$'\)/);
  assert.match(limiterTable, /hits INTEGER NOT NULL CHECK \(hits BETWEEN 1 AND 60\)/);
  assert.match(limiterTable, /expires_at TIMESTAMPTZ NOT NULL/);
  assert.match(sql, /auth_passkey_rate_limit_expiry_idx/);

  assert.match(limiterSource, /createHmac\("sha256"/);
  assert.match(limiterSource, /delta:passkey-limit:bucket:v1/);
  assert.match(limiterSource, /\.digest\("hex"\)/);
  assert.doesNotMatch(limiterSource, /readUInt|subarray\(|\.slice\(/);
  assert.match(limiterSource, /ON CONFLICT \(id\) DO UPDATE/);
  assert.match(limiterSource, /RETURNING id/);
  assert.match(limiterSource, /\[id, rule\.seconds, rule\.limit\]/);
});

test("limiter runtime contract hashes identities and uses one atomic UPSERT", async () => {
  const compiled = ts.transpileModule(limiterSource, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: "passkey-rate-limit.ts",
  }).outputText;
  const limiter = await import(
    `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`
  );
  const key = "passkey-rate-key-012345678901234567890123";
  const sourceIdentity = "203.0.113.10";
  const id = limiter.passkeyBucketId(
    key,
    "authenticationVerifyIp",
    sourceIdentity,
  );
  assert.match(id, /^[0-9a-f]{64}$/);
  assert.equal(id.includes(sourceIdentity), false);

  const calls = [];
  assert.equal(
    await limiter.takePasskeyRateLimit(
      {
        async query(statement, values = []) {
          calls.push({ statement, values });
          return { rowCount: /RETURNING id/.test(statement) ? 1 : 0, rows: [] };
        },
      },
      key,
      "authenticationVerifyIp",
      sourceIdentity,
      { limit: 5, seconds: 60 },
    ),
    true,
  );
  assert.equal(calls.length, 2);
  assert.match(calls[1].statement, /ON CONFLICT \(id\) DO UPDATE/);
  assert.deepEqual(calls[1].values, [id, 60, 5]);
  assert.equal(calls.some((call) => call.values.includes(sourceIdentity)), false);
});

test("schema overlay replaces counter and credential attributes after the official plugin", () => {
  assert.match(schemaSource, /passkey:\s*\{[\s\S]*modelName: "auth\.passkey"/);
  assert.match(schemaSource, /disableMigration: true/);
  assert.match(schemaSource, /credentialID:\s*\{[\s\S]*unique: true/);
  assert.match(schemaSource, /counter:\s*\{[\s\S]*type: "number"[\s\S]*bigint: true/);
  assert.match(schemaSource, /input: passkeyCounterToDatabase/);
  assert.match(schemaSource, /output: passkeyCounterFromDatabase/);
  assert.match(schemaSource, /id: "delta-passkey-schema-overlay"/);
  assert.match(schemaSource, /Registered after the official passkey plugin/);
});

test("provenance is adapter-visible while Delta owns migration execution", () => {
  assert.match(schemaSource, /passkeySessionMarker:\s*\{/);
  assert.match(schemaSource, /modelName: "app\.auth_passkey_session_marker"/);
  assert.match(schemaSource, /onDelete: "cascade"/);
  assert.match(schemaSource, /onDelete: "set null"/);
  assert.match(markerSource, /model: "passkeySessionMarker"/);
  assert.match(markerSource, /marker\.userVerified !== true/);

  const disabled = schemaSource.match(/disableMigration: true/g) ?? [];
  assert.equal(disabled.length, 2);
});

test("migration adds no challenge table, private key, or generalized preferences", () => {
  assert.doesNotMatch(sql, /CREATE TABLE\s+[^;]*(webauthn_challenge|passkey_challenge|auth_passkey_challenge)/i);
  assert.doesNotMatch(passkeyTable, /privateKey|secretKey|credentialSecret/i);
  assert.doesNotMatch(markerTable, /assurance_level|trusted_device|preferred_login|preferred_step_up/i);
});
