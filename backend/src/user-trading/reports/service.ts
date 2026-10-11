import {
  addReportExact,
  compareReportExact,
  divideReportExact,
  formatReportExact,
  parseReportDecimal,
  zeroReportExact,
} from "./exact.js";
import type {
  UserTradingReportBaseRow,
  UserTradingReportFilter,
  UserTradingReportRepository,
  UserTradingReportSummary,
} from "./types.js";

function isActive(row: UserTradingReportBaseRow): boolean {
  return row.positionId !== null && row.completedAt === null;
}

function isSkipped(row: UserTradingReportBaseRow): boolean {
  return (
    row.positionId === null &&
    row.participationStatus === "CANCELLED"
  );
}

export class UserTradingReportService {
  constructor(
    private readonly repository: UserTradingReportRepository,
  ) {}

  async history(
    userId: string,
    filter: UserTradingReportFilter = {},
  ): Promise<readonly UserTradingReportBaseRow[]> {
    return this.repository.listRows(userId, filter);
  }

  async summary(
    userId: string,
    filter: UserTradingReportFilter = {},
  ): Promise<UserTradingReportSummary> {
    const rows = await this.repository.listRows(userId, filter);

    let pnl = zeroReportExact();
    let returnSum = zeroReportExact();
    let terminalCount = 0n;
    let wins = 0;
    let losses = 0;
    let breakeven = 0;

    for (const row of rows) {
      if (
        row.realizedPnl === null ||
        row.realizedReturn === null
      ) {
        continue;
      }

      const rowPnl = parseReportDecimal(row.realizedPnl);
      const rowReturn = parseReportDecimal(row.realizedReturn);
      pnl = addReportExact(pnl, rowPnl);
      returnSum = addReportExact(returnSum, rowReturn);
      terminalCount += 1n;

      const sign = compareReportExact(rowPnl, zeroReportExact());
      if (sign > 0) wins += 1;
      else if (sign < 0) losses += 1;
      else breakeven += 1;
    }

    const followedCount = rows.filter(
      (row) => row.participationStatus === "FOLLOWING",
    ).length;
    const enteredCount = rows.filter(
      (row) => row.positionId !== null,
    ).length;
    const skippedCount = rows.filter(isSkipped).length;
    const activeCount = rows.filter(isActive).length;
    const completedCount = rows.filter(
      (row) => row.completedAt !== null,
    ).length;
    const stoppedCount = rows.filter(
      (row) => row.terminalReason === "STOP",
    ).length;
    const earlyExitCount = rows.filter(
      (row) => row.terminalReason === "MANUAL_EXIT",
    ).length;
    const tp3Count = rows.filter(
      (row) => row.terminalReason === "TP3",
    ).length;

    const averagePnl =
      terminalCount === 0n
        ? null
        : formatReportExact(divideReportExact(pnl, terminalCount));
    const averageReturn =
      terminalCount === 0n
        ? null
        : formatReportExact(
            divideReportExact(returnSum, terminalCount),
          );
    const decisive = BigInt(wins + losses);
    const winRate =
      decisive === 0n
        ? null
        : formatReportExact({
            numerator: BigInt(wins),
            denominator: decisive,
          });

    return Object.freeze({
      totalParticipations: rows.length,
      followedCount,
      enteredCount,
      skippedCount,
      activeCount,
      completedCount,
      stoppedCount,
      earlyExitCount,
      tp3Count,
      wins,
      losses,
      breakeven,
      realizedPnl: formatReportExact(pnl),
      averageRealizedPnl: averagePnl,
      averageRealizedReturn: averageReturn,
      winRate,
    });
  }
}
