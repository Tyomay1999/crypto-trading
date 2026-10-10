import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sql = readFileSync(
  new URL("../migrations/0008_projection_foundation.sql", import.meta.url),
  "utf8",
);

test("P6 creates exactly the four projection-owned tables", () => {
  assert.match(sql, /CREATE SCHEMA IF NOT EXISTS projection;/);
  const tables = [
    "published_signals",
    "signal_current",
    "signal_events",
    "signal_outcomes",
  ];

  for (const table of tables) {
    assert.match(
      sql,
      new RegExp(`CREATE TABLE projection\\.${table} \\(`),
    );
  }

  assert.equal(
    [...sql.matchAll(/CREATE TABLE projection\./g)].length,
    4,
  );
});

test("P6 remains isolated from app and auth schemas", () => {
  assert.doesNotMatch(sql, /\b(?:CREATE|ALTER|DROP|INSERT|UPDATE|DELETE)\b[^;]*\bapp\./is);
  assert.doesNotMatch(sql, /\b(?:CREATE|ALTER|DROP|INSERT|UPDATE|DELETE)\b[^;]*\bauth\./is);
  assert.doesNotMatch(sql, /REFERENCES\s+(?:app|auth)\./i);
});

test("P6 freezes lifecycle and terminal domains without inventing no-entry states", () => {
  for (const state of [
    "PUBLISHED",
    "WAITING_FOR_ENTRY",
    "ENTRY_REACHED",
    "TP1_REACHED",
    "TP2_REACHED",
    "TP3_REACHED",
    "STOP_REACHED",
  ]) {
    assert.match(sql, new RegExp(`'${state}'`));
  }

  assert.match(sql, /final_status IN \('STOP', 'TP3'\)/);
  assert.doesNotMatch(sql, /\bEXPIRED\b/);
  assert.doesNotMatch(sql, /\bNO_ENTRY\b/);
  assert.doesNotMatch(sql, /\bINVALIDATED\b/);
});

test("P6 preserves immutable timeline identity and domain event time", () => {
  assert.match(sql, /PRIMARY KEY \(signal_id, sequence\)/);
  assert.match(sql, /occurred_at TIMESTAMPTZ NOT NULL/);
  assert.match(sql, /signal_events_signal_time_idx/);
});

test("P6 keeps canonical projection entities as JSONB objects", () => {
  assert.match(sql, /projection_payload JSONB NOT NULL/);
  assert.match(sql, /snapshot_payload JSONB NOT NULL/);
  assert.match(sql, /event_payload JSONB NOT NULL/);
  assert.match(sql, /outcome_payload JSONB NOT NULL/);
  assert.match(
    sql,
    /dbdd0af64715596f705f3dff74f368fd1815dc26e22f326ddba10b400fa9dfa1/,
  );
});

test("P6 does not coerce contract decimal values into SQL numeric or floating-point columns", () => {
  const executableSql = sql
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*--.*$/gm, "");

  assert.doesNotMatch(
    executableSql,
    /\b(?:REAL|DOUBLE\s+PRECISION|NUMERIC|DECIMAL)\b/i,
  );
});
