import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sql = readFileSync(
  "migrations/0011_user_position_accounting.sql",
  "utf8",
);

test("U5 migration alters only app.user_position", () => {
  assert.doesNotMatch(sql, /\bALTER\s+TABLE\s+auth\./iu);
  assert.doesNotMatch(sql, /\bALTER\s+TABLE\s+projection\./iu);
  const altered = [...sql.matchAll(/ALTER TABLE\s+([^\s]+)/giu)].map(
    (match) => match[1],
  );
  assert.deepEqual([...new Set(altered)], ["app.user_position"]);
});

test("U5 persists direction, realized accounting and stop basis as TEXT", () => {
  assert.match(sql, /ADD COLUMN direction TEXT/iu);
  assert.match(sql, /ADD COLUMN realized_fraction TEXT NOT NULL/iu);
  assert.match(sql, /ADD COLUMN realized_pnl TEXT NOT NULL/iu);
  assert.match(sql, /ADD COLUMN stop_basis TEXT NOT NULL/iu);
});

test("U5 executable SQL introduces no floating-point monetary columns", () => {
  const executableSql = sql
    .replace(/--.*$/gmu, "")
    .replace(/'(?:''|[^'])*'/gu, "''");

  assert.doesNotMatch(
    executableSql,
    /\b(?:REAL|DOUBLE\s+PRECISION|NUMERIC|DECIMAL|FLOAT)\b/iu,
  );
});
