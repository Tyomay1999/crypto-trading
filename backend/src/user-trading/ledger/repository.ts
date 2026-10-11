import type {
  UserPositionSnapshot,
} from "../accounting/types.js";
import type {
  LedgerCommitResult,
  LedgerEventDraft,
  TerminalOutcomeDraft,
  UserPositionEventRecord,
  UserPositionOutcomeRecord,
} from "./types.js";

export interface UserTradingLedgerRepository {
  findOwnedPosition(
    userId: string,
    positionId: string,
  ): Promise<UserPositionSnapshot | null>;

  findEventByIdentity(
    userId: string,
    positionId: string,
    eventIdentity: string,
  ): Promise<{
    event: UserPositionEventRecord;
    outcome: UserPositionOutcomeRecord | null;
  } | null>;

  commitMutation(input: {
    userId: string;
    expectedVersion: string;
    nextPosition: UserPositionSnapshot;
    event: LedgerEventDraft;
    terminalOutcome: TerminalOutcomeDraft | null;
  }): Promise<LedgerCommitResult>;

  appendObservation(input: {
    userId: string;
    positionId: string;
    event: LedgerEventDraft;
  }): Promise<LedgerCommitResult>;
}
