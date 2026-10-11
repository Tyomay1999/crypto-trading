import type {
  UserPositionSnapshot,
} from "../accounting/types.js";

export type UserPositionEventType =
  | "ENTRY_RECORDED"
  | "STOP_UPDATED"
  | "STOP_MOVED_TO_ENTRY"
  | "TP_REALIZED"
  | "MANUAL_EXIT_RECORDED"
  | "STOP_REALIZED"
  | "POSITION_COMPLETED"
  | "GLOBAL_OUTCOME_OBSERVED";

export type UserTerminalReason =
  | "TP3"
  | "STOP"
  | "MANUAL_EXIT"
  | "CANCELLED";

export interface UserPositionEventRecord {
  eventId: string;
  positionId: string;
  participationId: string;
  userId: string;
  signalId: string;
  eventType: UserPositionEventType;
  eventIdentity: string;
  globalEventIdentity: string | null;
  globalSequence: string | null;
  occurredAt: string;
  observedAt: string;
  payload: Readonly<Record<string, unknown>>;
  createdAt: string;
}

export interface UserPositionOutcomeRecord {
  positionId: string;
  participationId: string;
  userId: string;
  signalId: string;
  terminalReason: UserTerminalReason;
  userTerminalState: "EXITED_EARLY" | "COMPLETED" | "STOPPED" | "CANCELLED";
  actualExitPrice: string | null;
  realizedPnl: string;
  realizedReturn: string;
  realizedFraction: string;
  fees: string;
  completedAt: string;
}

export interface LedgerEventDraft {
  eventId: string;
  eventType: UserPositionEventType;
  eventIdentity: string;
  globalEventIdentity: string | null;
  globalSequence: string | null;
  occurredAt: string;
  observedAt: string;
  payload: Readonly<Record<string, unknown>>;
}

export interface TerminalOutcomeDraft {
  terminalReason: UserTerminalReason;
  actualExitPrice: string | null;
  completedAt: string;
}

export type LedgerCommitResult =
  | {
      kind: "APPLIED";
      position: UserPositionSnapshot;
      event: UserPositionEventRecord;
      outcome: UserPositionOutcomeRecord | null;
    }
  | {
      kind: "IDEMPOTENT_REPLAY";
      position: UserPositionSnapshot;
      event: UserPositionEventRecord;
      outcome: UserPositionOutcomeRecord | null;
    }
  | { kind: "CONCURRENT_CONFLICT" }
  | { kind: "NOT_FOUND" }
  | { kind: "TERMINAL_CONFLICT" };
