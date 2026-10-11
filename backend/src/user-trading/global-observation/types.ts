import type {
  GlobalLifecycleState,
} from "../accounting/types.js";

export type GlobalObservationKind =
  | "TARGET_REACHED"
  | "STOP_REACHED"
  | "GLOBAL_OUTCOME";

export type GlobalTargetName =
  | "TP1"
  | "TP2"
  | "TP3";

export type GlobalTerminalStatus =
  | "STOP"
  | "TP3";

export type GlobalSignalObservation =
  | Readonly<{
      kind: "TARGET_REACHED";
      signalId: string;
      globalEventIdentity: string;
      globalSequence: string;
      occurredAt: string;
      state: Extract<
        GlobalLifecycleState,
        "TP1_REACHED" | "TP2_REACHED" | "TP3_REACHED"
      >;
      target: GlobalTargetName;
      price: string;
      allocationFraction: string;
    }>
  | Readonly<{
      kind: "STOP_REACHED";
      signalId: string;
      globalEventIdentity: string;
      globalSequence: string;
      occurredAt: string;
      state: "STOP_REACHED";
    }>
  | Readonly<{
      kind: "GLOBAL_OUTCOME";
      signalId: string;
      globalEventIdentity: string;
      occurredAt: string;
      finalStatus: GlobalTerminalStatus;
    }>;

export type UserPositionBinding = Readonly<{
  userId: string;
  positionId: string;
}>;

export interface GlobalObservationPositionResolver {
  listOpenPositionsForSignal(
    signalId: string,
  ): Promise<readonly UserPositionBinding[]>;
}
