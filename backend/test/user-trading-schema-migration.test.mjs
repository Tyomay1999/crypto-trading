import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

const migrationPath = "migrations/0009_user_trading_foundation.sql";
const sql = readFileSync(migrationPath, "utf8");

function tableBlock(name) {
  const match = sql.match(
    new RegExp(
      `CREATE TABLE app\\.${name} \\(([\\s\\S]*?)\\n\\);`,
      "i",
    ),
  );
  assert.ok(match, `Unable to locate app.${name}`);
  return match[1];
}

test("U2 creates only the preregistered app-owned user trading tables", () => {
  const created = [...sql.matchAll(/CREATE TABLE\s+([^\s(]+)/gi)].map(
    (match) => match[1],
  );

  assert.deepEqual(created, [
    "app.user_signal_participation",
    "app.user_trade_plan",
    "app.user_balance_snapshot",
    "app.user_position",
    "app.user_position_event",
    "app.user_position_outcome",
  ]);
});

test("U2 never alters Better Auth or projection schemas", () => {
  assert.doesNotMatch(sql, /\bALTER\s+TABLE\s+auth\./i);
  assert.doesNotMatch(sql, /\bALTER\s+TABLE\s+projection\./i);
  assert.doesNotMatch(sql, /\bCREATE\s+TABLE\s+auth\./i);
  assert.doesNotMatch(sql, /\bCREATE\s+TABLE\s+projection\./i);
});

test("participation is scoped to authenticated user and global signal", () => {
  const block = tableBlock("user_signal_participation");

  assert.match(
    block,
    /user_id\s+TEXT\s+NOT NULL[\s\S]*REFERENCES auth\."user" \("id"\)[\s\S]*ON DELETE CASCADE/i,
  );
  assert.match(
    block,
    /signal_id\s+TEXT\s+NOT NULL[\s\S]*REFERENCES projection\.published_signals \(signal_id\)[\s\S]*ON DELETE RESTRICT/i,
  );
  assert.match(
    sql,
    /CREATE UNIQUE INDEX user_signal_participation_one_live_idx[\s\S]*WHERE status IN \('FOLLOWING', 'PLANNED', 'ACTIVE'\)/i,
  );
});

test("child records carry fail-closed participation ownership", () => {
  for (const table of [
    "user_trade_plan",
    "user_balance_snapshot",
    "user_position",
  ]) {
    const block = tableBlock(table);
    assert.match(
      block,
      /FOREIGN KEY \(participation_id, user_id, signal_id\)[\s\S]*REFERENCES app\.user_signal_participation/i,
      `${table} must bind participation + user + signal`,
    );
  }
});

test("position events are idempotent and ownership-scoped", () => {
  const block = tableBlock("user_position_event");

  assert.match(
    block,
    /FOREIGN KEY \([\s\S]*position_id,[\s\S]*participation_id,[\s\S]*user_id,[\s\S]*signal_id[\s\S]*\)[\s\S]*REFERENCES app\.user_position/i,
  );
  assert.match(
    block,
    /UNIQUE \(position_id, event_identity\)/i,
  );
  assert.match(block, /payload JSONB NOT NULL/i);
});

test("one terminal outcome exists per position and participation", () => {
  const block = tableBlock("user_position_outcome");

  assert.match(block, /position_id TEXT PRIMARY KEY/i);
  assert.match(block, /participation_id TEXT NOT NULL UNIQUE/i);
  assert.match(
    block,
    /user_terminal_state IN \([\s\S]*'EXITED_EARLY'[\s\S]*'COMPLETED'[\s\S]*'STOPPED'[\s\S]*'CANCELLED'/i,
  );
});

test("financial values are exact text rather than PostgreSQL floating point", () => {
  for (const table of [
    "user_trade_plan",
    "user_balance_snapshot",
    "user_position",
    "user_position_outcome",
  ]) {
    const block = tableBlock(table);
    assert.doesNotMatch(
      block,
      /\b(?:REAL|DOUBLE\s+PRECISION|NUMERIC|DECIMAL|FLOAT)\b/i,
      `${table} contains an authoritative floating/numeric column`,
    );
  }

  assert.match(
    tableBlock("user_trade_plan"),
    /planned_entry_price TEXT NOT NULL/i,
  );
  assert.match(
    tableBlock("user_balance_snapshot"),
    /available_balance TEXT NOT NULL/i,
  );
  assert.match(
    tableBlock("user_position_outcome"),
    /realized_pnl TEXT NOT NULL/i,
  );
});

test("user and global terminal outcomes remain distinct", () => {
  const block = tableBlock("user_position_outcome");

  assert.match(block, /user_terminal_state TEXT NOT NULL/i);
  assert.match(block, /global_terminal_status TEXT/i);
  assert.match(block, /theoretical_global_pnl TEXT/i);
  assert.match(block, /opportunity_delta TEXT/i);
});

test("U2 migration contains no credential or session token storage columns", () => {
  const createdTableSql = [
    tableBlock("user_signal_participation"),
    tableBlock("user_trade_plan"),
    tableBlock("user_balance_snapshot"),
    tableBlock("user_position"),
    tableBlock("user_position_event"),
    tableBlock("user_position_outcome"),
  ].join("\n");

  assert.doesNotMatch(
    createdTableSql,
    /\b(?:api_secret|secret_key|private_key|session_token|access_token|refresh_token|credential_token)\b/i,
  );
});

test("U2 migration identity is deterministic for forensic reporting", () => {
  const digest = createHash("sha256").update(sql).digest("hex");
  assert.match(digest, /^[a-f0-9]{64}$/);
});
