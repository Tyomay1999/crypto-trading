import type {
  PositionDirection,
  UserPositionSnapshot,
} from "./types.js";

export interface EntryContext {
  participationId: string;
  userId: string;
  signalId: string;
  participationStatus: string;
  selectedPositionNotional: string;
  selectedStopPrice: string;
}

export interface PositionAccountingRepository {
  findEntryContext(
    userId: string,
    participationId: string,
  ): Promise<EntryContext | null>;

  createPosition(input: {
    snapshot: UserPositionSnapshot;
  }): Promise<UserPositionSnapshot | null>;

  findOwnedPosition(
    userId: string,
    positionId: string,
  ): Promise<UserPositionSnapshot | null>;

  savePositionCas(input: {
    previousVersion: string;
    snapshot: UserPositionSnapshot;
  }): Promise<UserPositionSnapshot | null>;
}
