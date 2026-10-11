import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sql = readFileSync(
  "migrations/0010_user_trade_plan_recommendation_evidence.sql",
  "utf8",
);

test("U4 migration modifies only app-owned user trading tables", () => {
  assert.doesNotMatch(sql, /\bALTER\s+TABLE\s+auth\./iu);
  assert.doesNotMatch(sql, /\bALTER\s+TABLE\s+projection\./iu);

  const altered = [...sql.matchAll(/ALTER TABLE\s+([^\s]+)/giu)].map(
    (match) => match[1],
  );

  assert.deepEqual(
    [...new Set(altered)].sort(),
    ["app.user_balance_snapshot", "app.user_trade_plan"],
  );
});

test("U4 persists snapshot linkage, suggested leverage and required margin", () => {
  assert.match(sql, /ADD COLUMN balance_snapshot_id TEXT/iu);
  assert.match(sql, /ADD COLUMN suggested_leverage TEXT/iu);
  assert.match(sql, /ADD COLUMN required_margin TEXT/iu);
  assert.match(
    sql,
    /FOREIGN KEY \([\s\S]*balance_snapshot_id,[\s\S]*participation_id,[\s\S]*user_id,[\s\S]*signal_id[\s\S]*\)[\s\S]*REFERENCES app\.user_balance_snapshot/iu,
  );
});

test("U4 migration introduces no floating-point or numeric monetary columns", () => {
  // Type auditing must inspect executable SQL, not prose in comments or
  // CHECK/COMMENT string literals (for example "canonical decimal text").
  const executableSql = sql
    .replace(/--.*$/gmu, "")
    .replace(/'(?:''|[^'])*'/gu, "''");

  assert.doesNotMatch(
    executableSql,
    /\b(?:REAL|DOUBLE\s+PRECISION|NUMERIC|DECIMAL|FLOAT)\b/iu,
  );
});
