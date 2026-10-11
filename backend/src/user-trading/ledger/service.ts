import {
  applyGlobalStop,
  applyGlobalTarget,
  applyManualExit,
  moveUserStop,
} from "../accounting/engine.js";
import type {
  GlobalStopInput,
  GlobalTargetInput,
  ManualExitInput,
  StopMoveInput,
} from "../accounting/types.js";
import type {
  UserTradingLedgerRepository,
} from "./repository.js";
import type {
  LedgerEventDraft,
  TerminalOutcomeDraft,
  UserPositionEventType,
} from "./types.js";

export interface LedgerIdFactory {
  createEventId(): string;
}

function opaque(value: string, field: string, max = 256): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > max ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError(`${field} must be a bounded opaque identifier`);
  }
  return value;
}

function eventDraft(input: {
  ids: LedgerIdFactory;
  eventType: UserPositionEventType;
  eventIdentity: string;
  globalEventIdentity?: string | null;
  globalSequence?: string | null;
  occurredAt: string;
  observedAt: string;
  payload: Readonly<Record<string, unknown>>;
}): LedgerEventDraft {
  return {
    eventId: opaque(input.ids.createEventId(), "eventId", 128),
    eventType: input.eventType,
    eventIdentity: opaque(input.eventIdentity, "eventIdentity", 256),
    globalEventIdentity:
      input.globalEventIdentity === undefined ||
      input.globalEventIdentity === null
        ? null
        : opaque(input.globalEventIdentity, "globalEventIdentity", 256),
    globalSequence: input.globalSequence ?? null,
    occurredAt: input.occurredAt,
    observedAt: input.observedAt,
    payload: input.payload,
  };
}

export class UserTradingLedgerService {
  readonly #repository: UserTradingLedgerRepository;
  readonly #ids: LedgerIdFactory;

  constructor(input: {
    repository: UserTradingLedgerRepository;
    idFactory: LedgerIdFactory;
  }) {
    this.#repository = input.repository;
    this.#ids = input.idFactory;
  }

  async applyTarget(input: {
    userId: string;
    positionId: string;
    eventIdentity: string;
    globalEventIdentity: string;
    observedAt: string;
    target: GlobalTargetInput;
  }) {
    const userId = opaque(input.userId, "userId");
    const positionId = opaque(input.positionId, "positionId", 128);

    const replay = await this.#repository.findEventByIdentity(
      userId,
      positionId,
      input.eventIdentity,
    );
    if (replay) {
      const position = await this.#repository.findOwnedPosition(userId, positionId);
      if (!position) return { kind: "NOT_FOUND" as const };
      return {
        kind: "IDEMPOTENT_REPLAY" as const,
        position,
        event: replay.event,
        outcome: replay.outcome,
      };
    }

    const current = await this.#repository.findOwnedPosition(userId, positionId);
    if (!current) return { kind: "NOT_FOUND" as const };

    const result = applyGlobalTarget(current, input.target);
    if (result.kind === "STALE_OR_DUPLICATE") {
      return result;
    }

    const terminal = result.position.state === "COMPLETED";
    const terminalOutcome: TerminalOutcomeDraft | null = terminal
      ? {
          terminalReason: "TP3",
          actualExitPrice: null,
          completedAt: input.target.occurredAt,
        }
      : null;

    return this.#repository.commitMutation({
      userId,
      expectedVersion: current.version,
      nextPosition: result.position,
      event: eventDraft({
        ids: this.#ids,
        eventType: terminal ? "POSITION_COMPLETED" : "TP_REALIZED",
        eventIdentity: input.eventIdentity,
        globalEventIdentity: input.globalEventIdentity,
        globalSequence: input.target.globalSequence,
        occurredAt: input.target.occurredAt,
        observedAt: input.observedAt,
        payload: {
          target: input.target.target,
          price: input.target.price,
          allocationFraction: input.target.allocationFraction,
        },
      }),
      terminalOutcome,
    });
  }

  async moveStop(input: {
    userId: string;
    positionId: string;
    eventIdentity: string;
    observedAt: string;
    move: StopMoveInput;
  }) {
    const userId = opaque(input.userId, "userId");
    const positionId = opaque(input.positionId, "positionId", 128);

    const replay = await this.#repository.findEventByIdentity(
      userId,
      positionId,
      input.eventIdentity,
    );
    if (replay) {
      const position = await this.#repository.findOwnedPosition(userId, positionId);
      if (!position) return { kind: "NOT_FOUND" as const };
      return {
        kind: "IDEMPOTENT_REPLAY" as const,
        position,
        event: replay.event,
        outcome: replay.outcome,
      };
    }

    const current = await this.#repository.findOwnedPosition(userId, positionId);
    if (!current) return { kind: "NOT_FOUND" as const };

    const moved = moveUserStop(current, input.move);
    if (moved.kind !== "APPLIED") return moved;

    return this.#repository.commitMutation({
      userId,
      expectedVersion: current.version,
      nextPosition: moved.position,
      event: eventDraft({
        ids: this.#ids,
        eventType:
          input.move.basis === "ENTRY"
            ? "STOP_MOVED_TO_ENTRY"
            : "STOP_UPDATED",
        eventIdentity: input.eventIdentity,
        occurredAt: input.observedAt,
        observedAt: input.observedAt,
        payload: {
          basis: input.move.basis,
          price: input.move.price,
        },
      }),
      terminalOutcome: null,
    });
  }

  async applyStop(input: {
    userId: string;
    positionId: string;
    eventIdentity: string;
    globalEventIdentity: string;
    observedAt: string;
    stop: GlobalStopInput;
  }) {
    const userId = opaque(input.userId, "userId");
    const positionId = opaque(input.positionId, "positionId", 128);

    const replay = await this.#repository.findEventByIdentity(
      userId,
      positionId,
      input.eventIdentity,
    );
    if (replay) {
      const position = await this.#repository.findOwnedPosition(userId, positionId);
      if (!position) return { kind: "NOT_FOUND" as const };
      return {
        kind: "IDEMPOTENT_REPLAY" as const,
        position,
        event: replay.event,
        outcome: replay.outcome,
      };
    }

    const current = await this.#repository.findOwnedPosition(userId, positionId);
    if (!current) return { kind: "NOT_FOUND" as const };

    const stopped = applyGlobalStop(current, input.stop);
    if (stopped.kind === "STALE_OR_DUPLICATE") return stopped;

    return this.#repository.commitMutation({
      userId,
      expectedVersion: current.version,
      nextPosition: stopped.position,
      event: eventDraft({
        ids: this.#ids,
        eventType: "STOP_REALIZED",
        eventIdentity: input.eventIdentity,
        globalEventIdentity: input.globalEventIdentity,
        globalSequence: input.stop.globalSequence,
        occurredAt: input.stop.occurredAt,
        observedAt: input.observedAt,
        payload: {
          stopPrice: current.selectedStopPrice,
          stopBasis: current.stopBasis,
        },
      }),
      terminalOutcome: {
        terminalReason: "STOP",
        actualExitPrice: current.selectedStopPrice,
        completedAt: input.stop.occurredAt,
      },
    });
  }

  async manualExit(input: {
    userId: string;
    positionId: string;
    eventIdentity: string;
    observedAt: string;
    exit: ManualExitInput;
  }) {
    const userId = opaque(input.userId, "userId");
    const positionId = opaque(input.positionId, "positionId", 128);

    const replay = await this.#repository.findEventByIdentity(
      userId,
      positionId,
      input.eventIdentity,
    );
    if (replay) {
      const position = await this.#repository.findOwnedPosition(userId, positionId);
      if (!position) return { kind: "NOT_FOUND" as const };
      return {
        kind: "IDEMPOTENT_REPLAY" as const,
        position,
        event: replay.event,
        outcome: replay.outcome,
      };
    }

    const current = await this.#repository.findOwnedPosition(userId, positionId);
    if (!current) return { kind: "NOT_FOUND" as const };

    const exited = applyManualExit(current, input.exit);

    return this.#repository.commitMutation({
      userId,
      expectedVersion: current.version,
      nextPosition: exited,
      event: eventDraft({
        ids: this.#ids,
        eventType: "MANUAL_EXIT_RECORDED",
        eventIdentity: input.eventIdentity,
        occurredAt: input.exit.occurredAt,
        observedAt: input.observedAt,
        payload: {
          exitPrice: input.exit.price,
          remainingFractionBeforeExit: current.remainingFraction,
        },
      }),
      terminalOutcome: {
        terminalReason: "MANUAL_EXIT",
        actualExitPrice: input.exit.price,
        completedAt: input.exit.occurredAt,
      },
    });
  }

  async observeGlobalOutcome(input: {
    userId: string;
    positionId: string;
    eventIdentity: string;
    globalEventIdentity: string;
    globalSequence: string;
    occurredAt: string;
    observedAt: string;
    globalTerminalStatus: "TP3" | "STOP";
    payload?: Readonly<Record<string, unknown>>;
  }) {
    const userId = opaque(input.userId, "userId");
    const positionId = opaque(input.positionId, "positionId", 128);

    return this.#repository.appendObservation({
      userId,
      positionId,
      event: eventDraft({
        ids: this.#ids,
        eventType: "GLOBAL_OUTCOME_OBSERVED",
        eventIdentity: input.eventIdentity,
        globalEventIdentity: input.globalEventIdentity,
        globalSequence: input.globalSequence,
        occurredAt: input.occurredAt,
        observedAt: input.observedAt,
        payload: {
          globalTerminalStatus: input.globalTerminalStatus,
          ...(input.payload ?? {}),
        },
      }),
    });
  }
}
