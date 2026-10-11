import type { PositionDirection } from "../accounting/types.js";
import type { UserTerminalReason } from "../ledger/types.js";

export type ReportParticipationStatus = string;

export type ReportGlobalTerminalStatus = "STOP" | "TP3" | null;

export type UserTradingReportBaseRow = Readonly<{
  participationId: string;
  signalId: string;
  participationStatus: ReportParticipationStatus;
  followedAt: string;
  positionId: string | null;
  direction: PositionDirection | null;
  positionState: string | null;
  terminalAt: string | null;
  terminalReason: UserTerminalReason | null;
  userTerminalState:
    | "EXITED_EARLY"
    | "COMPLETED"
    | "STOPPED"
    | "CANCELLED"
    | null;
  globalTerminalStatus: ReportGlobalTerminalStatus;
  realizedPnl: string | null;
  realizedReturn: string | null;
  realizedFraction: string | null;
  completedAt: string | null;
}>;

export type UserTradingReportFilter = Readonly<{
  direction?: PositionDirection;
  terminalReason?: UserTerminalReason;
  symbol?: string;
  strategy?: string;
  globalTerminalStatus?: "STOP" | "TP3";
  from?: string;
  to?: string;
}>;

export type UserTradingReportHistoryRow =
  UserTradingReportBaseRow &
  Readonly<{
    symbol: string | null;
    strategy: string | null;
  }>;

export type UserTradingReportSummary = Readonly<{
  totalParticipations: number;
  followedCount: number;
  enteredCount: number;
  skippedCount: number;
  activeCount: number;
  completedCount: number;
  stoppedCount: number;
  earlyExitCount: number;
  tp3Count: number;
  wins: number;
  losses: number;
  breakeven: number;
  realizedPnl: string;
  averageRealizedPnl: string | null;
  averageRealizedReturn: string | null;
  winRate: string | null;
}>;

export interface UserTradingReportRepository {
  listRows(
    userId: string,
    filter: UserTradingReportFilter,
  ): Promise<readonly UserTradingReportHistoryRow[]>;
}
