export type PositionDirection = "LONG" | "SHORT";
export type UserPositionState =
  | "PENDING_ENTRY"
  | "OPEN"
  | "PARTIALLY_REALIZED"
  | "EXITED_EARLY"
  | "COMPLETED"
  | "STOPPED"
  | "CANCELLED";

export type StopBasis = "ORIGINAL" | "ENTRY" | "TP1" | "TP2";
export type GlobalLifecycleState =
  | "PUBLISHED"
  | "WAITING_FOR_ENTRY"
  | "ENTRY_REACHED"
  | "TP1_REACHED"
  | "TP2_REACHED"
  | "TP3_REACHED"
  | "STOP_REACHED";

export interface UserPositionSnapshot {
  positionId: string;
  participationId: string;
  userId: string;
  signalId: string;
  direction: PositionDirection;
  state: UserPositionState;
  actualEntryPrice: string;
  enteredAt: string;
  initialQuantity: string;
  initialNotional: string;
  remainingFraction: string;
  realizedFraction: string;
  realizedPnl: string;
  selectedStopPrice: string;
  stopBasis: StopBasis;
  lastGlobalSequence: string;
  lastGlobalState: GlobalLifecycleState;
  version: string;
  terminalAt: string | null;
}

export interface OpenPositionInput {
  positionId: string;
  participationId: string;
  userId: string;
  signalId: string;
  direction: PositionDirection;
  actualEntryPrice: string;
  initialNotional: string;
  originalStopPrice: string;
  enteredAt: string;
  globalSequence: string;
}

export interface GlobalTargetInput {
  target: "TP1" | "TP2" | "TP3";
  price: string;
  allocationFraction: string;
  globalSequence: string;
  occurredAt: string;
}

export interface StopMoveInput {
  basis: Exclude<StopBasis, "ORIGINAL">;
  price: string;
}

export interface GlobalStopInput {
  globalSequence: string;
  occurredAt: string;
}

export interface ManualExitInput {
  price: string;
  occurredAt: string;
}

export type AccountingMutationResult =
  | { kind: "APPLIED"; position: UserPositionSnapshot }
  | { kind: "STALE_OR_DUPLICATE"; position: UserPositionSnapshot };

export type StopMoveResult =
  | { kind: "APPLIED"; position: UserPositionSnapshot }
  | { kind: "NOT_ELIGIBLE"; position: UserPositionSnapshot }
  | { kind: "NON_MONOTONIC"; position: UserPositionSnapshot };
