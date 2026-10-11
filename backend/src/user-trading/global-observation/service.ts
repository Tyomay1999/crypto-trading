import type {
  UserTradingLedgerService,
} from "../ledger/service.js";
import type {
  GlobalSignalObservation,
  GlobalObservationPositionResolver,
} from "./types.js";

export type GlobalObservationApplyResult =
  Readonly<{
    signalId: string;
    observationKind:
      GlobalSignalObservation["kind"];
    positionsObserved: number;
  }>;

export class UserTradingGlobalObservationService {
  constructor(
    private readonly positions:
      GlobalObservationPositionResolver,
    private readonly ledger:
      UserTradingLedgerService,
  ) {}

  async apply(
    observation: GlobalSignalObservation,
  ): Promise<GlobalObservationApplyResult> {
    const bindings =
      await this.positions.listOpenPositionsForSignal(
        observation.signalId,
      );

    if (observation.kind === "GLOBAL_OUTCOME") {
      for (const binding of bindings) {
        await this.ledger.observeGlobalOutcome({
          userId: binding.userId,
          positionId: binding.positionId,
          eventIdentity:
            observation.globalEventIdentity,
          globalEventIdentity:
            observation.globalEventIdentity,
          globalSequence: "0",
          occurredAt:
            observation.occurredAt,
          observedAt:
            observation.occurredAt,
          globalTerminalStatus:
            observation.finalStatus,
        });
      }

      return Object.freeze({
        signalId: observation.signalId,
        observationKind: observation.kind,
        positionsObserved: bindings.length,
      });
    }

    if (observation.kind === "TARGET_REACHED") {
      for (const binding of bindings) {
        await this.ledger.applyTarget({
          userId: binding.userId,
          positionId: binding.positionId,
          eventIdentity:
            observation.globalEventIdentity,
          globalEventIdentity:
            observation.globalEventIdentity,
          observedAt:
            observation.occurredAt,
          target: {
            target: observation.target,
            price: observation.price,
            allocationFraction:
              observation.allocationFraction,
            globalSequence:
              observation.globalSequence,
            occurredAt:
              observation.occurredAt,
          },
        });
      }

      return Object.freeze({
        signalId: observation.signalId,
        observationKind: observation.kind,
        positionsObserved: bindings.length,
      });
    }

    for (const binding of bindings) {
      await this.ledger.applyStop({
        userId: binding.userId,
        positionId: binding.positionId,
        eventIdentity:
          observation.globalEventIdentity,
        globalEventIdentity:
          observation.globalEventIdentity,
        observedAt:
          observation.occurredAt,
        stop: {
          globalSequence:
            observation.globalSequence,
          occurredAt:
            observation.occurredAt,
        },
      });
    }

    return Object.freeze({
      signalId: observation.signalId,
      observationKind: observation.kind,
      positionsObserved: bindings.length,
    });
  }
}
