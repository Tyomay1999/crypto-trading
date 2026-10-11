import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

import {
  PostgresUserTradingReportRepository,
  UserTradingReportService,
  formatReportExact,
  parseReportDecimal,
} from "../dist/user-trading/reports/index.js";

function row(overrides = {}) {
  return {
    participationId: "participation-a",
    signalId: "signal-a",
    participationStatus: "COMPLETED",
    followedAt: "2026-10-11T10:00:00.000Z",
    positionId: "position-a",
    direction: "LONG",
    positionState: "COMPLETED",
    terminalAt: "2026-10-11T11:00:00.000Z",
    terminalReason: "TP3",
    userTerminalState: "COMPLETED",
    globalTerminalStatus: "TP3",
    realizedPnl: "65",
    realizedReturn: "0.065",
    realizedFraction: "1",
    completedAt: "2026-10-11T11:00:00.000Z",
    ...overrides,
  };
}

test("report exact decimal never requires JS floating point", () => {
  assert.equal(
    formatReportExact(parseReportDecimal("12345678901234567890.125")),
    "12345678901234567890.125",
  );
});

test("summary aggregates mixed wins, losses and breakeven exactly", async () => {
  const service = new UserTradingReportService({
    async listRows() {
      return [
        row({ realizedPnl: "65", realizedReturn: "0.065" }),
        row({
          participationId: "p-b",
          positionId: "pos-b",
          terminalReason: "STOP",
          userTerminalState: "STOPPED",
          globalTerminalStatus: "STOP",
          realizedPnl: "-15",
          realizedReturn: "-0.03",
        }),
        row({
          participationId: "p-c",
          positionId: "pos-c",
          realizedPnl: "0",
          realizedReturn: "0",
        }),
      ];
    },
  });

  const summary = await service.summary("user-a");

  assert.equal(summary.totalParticipations, 3);
  assert.equal(summary.completedCount, 3);
  assert.equal(summary.wins, 1);
  assert.equal(summary.losses, 1);
  assert.equal(summary.breakeven, 1);
  assert.equal(summary.realizedPnl, "50");
  assert.equal(summary.averageRealizedPnl, "16.666666666666");
  assert.equal(summary.averageRealizedReturn, "0.011666666666");
  assert.equal(summary.winRate, "0.5");
});

test("early exit remains realized user result even when global later TP3", async () => {
  const service = new UserTradingReportService({
    async listRows() {
      return [
        row({
          terminalReason: "MANUAL_EXIT",
          userTerminalState: "EXITED_EARLY",
          globalTerminalStatus: "TP3",
          realizedPnl: "65",
          realizedReturn: "0.065",
        }),
      ];
    },
  });

  const [history] = await service.history("user-a");
  const summary = await service.summary("user-a");

  assert.equal(history.terminalReason, "MANUAL_EXIT");
  assert.equal(history.globalTerminalStatus, "TP3");
  assert.equal(summary.earlyExitCount, 1);
  assert.equal(summary.tp3Count, 0);
  assert.equal(summary.realizedPnl, "65");
});

test("selected user outcome is aggregated directly rather than recommendation", async () => {
  const service = new UserTradingReportService({
    async listRows() {
      return [
        row({
          realizedPnl: "35",
          realizedReturn: "0.1",
        }),
      ];
    },
  });

  const summary = await service.summary("user-a");
  assert.equal(summary.realizedPnl, "35");
  assert.equal(summary.averageRealizedReturn, "0.1");
});

test("repository SQL is user-scoped and parameterizes filters", async () => {
  const calls = [];
  const repository = new PostgresUserTradingReportRepository({
    async query(text, values) {
      calls.push([text, values]);
      return { rows: [] };
    },
  });

  await repository.listRows("user-a", {
    direction: "LONG",
    terminalReason: "STOP",
    from: "2026-10-01T00:00:00.000Z",
    to: "2026-10-31T23:59:59.000Z",
  });

  assert.equal(calls.length, 1);
  const [sql, values] = calls[0];
  assert.match(sql, /p\.user_id = \$1/u);
  assert.match(sql, /pos\.direction = \$2/u);
  assert.match(sql, /o\.terminal_reason = \$3/u);
  assert.equal(values[0], "user-a");
  assert.equal(values[1], "LONG");
  assert.equal(values[2], "STOP");
  assert.doesNotMatch(sql, /user-a/u);
});

test("two users cannot contribute through the same repository query", async () => {
  const calls = [];
  const repository = new PostgresUserTradingReportRepository({
    async query(text, values) {
      calls.push([text, values]);
      return { rows: [] };
    },
  });

  await repository.listRows("user-a", {});
  await repository.listRows("user-b", {});

  assert.deepEqual(
    calls.map(([, values]) => values[0]),
    ["user-a", "user-b"],
  );
  assert.ok(calls.every(([sql]) => /p\.user_id = \$1/u.test(sql)));
});

test("report core source does not import frozen auth/security/session implementation", async () => {
  const source = await fs.readFile(
    new URL("../src/user-trading/reports/service.ts", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(source, /auth\/|security|session-context/u);
});
