import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

test("reports use trusted User Trading identity boundary", async () => {
  const r=await fs.readFile(new URL("../src/user-trading/api/router.ts",import.meta.url),"utf8");
  const c=await fs.readFile(new URL("../src/user-trading/api/composition.ts",import.meta.url),"utf8");
  assert.match(r,/\/reports\/summary/u);
  assert.match(r,/\/reports\/history/u);
  assert.match(r,/d\.resolveTrustedContext\(res\)/u);
  assert.match(r,/rejectIdentity\(req,null\)/u);
  assert.match(c,/getCurrentSessionContext\(response\)\.userId/u);
});

test("report filters are bounded and client identity hints remain forbidden", async () => {
  const s=await fs.readFile(new URL("../src/user-trading/api/router.ts",import.meta.url),"utf8");
  for (const f of ["direction","terminalReason","symbol","strategy","globalTerminalStatus","from","to"]) assert.match(s,new RegExp(`"${f}"`,"u"));
  for (const f of ["userId","user_id","ownerId","accountUserId","sessionUserId"]) assert.match(s,new RegExp(`"${f}"`,"u"));
});

test("report repository joins Projection read-only while PnL remains outcome-sourced", async () => {
  const s=await fs.readFile(new URL("../src/user-trading/reports/postgres-repository.ts",import.meta.url),"utf8");
  assert.match(s,/LEFT JOIN projection\.published_signals gs/u);
  assert.match(s,/gs\.symbol/u);
  assert.match(s,/strategyId/u);
  assert.match(s,/o\.realized_pnl/u);
  assert.match(s,/o\.realized_return/u);
  assert.match(s,/p\.user_id = \$1/u);
  assert.doesNotMatch(s,/INSERT INTO projection|UPDATE projection|DELETE FROM projection/u);
});

test("composition preserves ledger/read repositories and adds report service", async () => {
  const s=await fs.readFile(new URL("../src/user-trading/api/composition.ts",import.meta.url),"utf8");
  assert.match(s,/PostgresUserTradingLedgerRepository/u);
  assert.match(s,/PostgresUserTradingApiReadRepository/u);
  assert.match(s,/PostgresUserTradingReportRepository/u);
  assert.match(s,/UserTradingReportService/u);
});
