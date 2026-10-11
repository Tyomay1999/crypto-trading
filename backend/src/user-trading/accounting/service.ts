import {
  applyGlobalStop,
  applyGlobalTarget,
  applyManualExit,
  moveUserStop,
  openUserPosition,
} from "./engine.js";
import type { PositionAccountingRepository } from "./repository.js";
import type {
  GlobalStopInput,
  GlobalTargetInput,
  ManualExitInput,
  PositionDirection,
  StopMoveInput,
  UserPositionSnapshot,
} from "./types.js";

export interface AccountingIdFactory {
  createPositionId(): string;
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

export class UserPositionAccountingService {
  readonly #repository: PositionAccountingRepository;
  readonly #ids: AccountingIdFactory;

  constructor(input: {
    repository: PositionAccountingRepository;
    idFactory: AccountingIdFactory;
  }) {
    this.#repository = input.repository;
    this.#ids = input.idFactory;
  }

  async recordEntry(input: {
    userId: string;
    participationId: string;
    signalId: string;
    direction: PositionDirection;
    actualEntryPrice: string;
    enteredAt: string;
    globalSequence: string;
  }): Promise<
    | { kind: "OPENED"; position: UserPositionSnapshot }
    | { kind: "NOT_FOUND" }
    | { kind: "STATE_CONFLICT" }
  > {
    const userId = opaque(input.userId, "userId");
    const participationId = opaque(input.participationId, "participationId", 128);
    const context = await this.#repository.findEntryContext(
      userId,
      participationId,
    );

    if (!context || context.signalId !== input.signalId) {
      return { kind: "NOT_FOUND" };
    }
    if (context.participationStatus !== "PLANNED") {
      return { kind: "STATE_CONFLICT" };
    }

    const position = openUserPosition({
      positionId: opaque(this.#ids.createPositionId(), "positionId", 128),
      participationId,
      userId,
      signalId: context.signalId,
      direction: input.direction,
      actualEntryPrice: input.actualEntryPrice,
      initialNotional: context.selectedPositionNotional,
      originalStopPrice: context.selectedStopPrice,
      enteredAt: input.enteredAt,
      globalSequence: input.globalSequence,
    });

    const saved = await this.#repository.createPosition({ snapshot: position });
    return saved
      ? { kind: "OPENED", position: saved }
      : { kind: "STATE_CONFLICT" };
  }

  async applyTarget(input: {
    userId: string;
    positionId: string;
    target: GlobalTargetInput;
  }) {
    const current = await this.#owned(input.userId, input.positionId);
    if (!current) return { kind: "NOT_FOUND" as const };

    const result = applyGlobalTarget(current, input.target);
    if (result.kind === "STALE_OR_DUPLICATE") {
      return result;
    }

    const saved = await this.#repository.savePositionCas({
      previousVersion: current.version,
      snapshot: result.position,
    });

    return saved
      ? { kind: "APPLIED" as const, position: saved }
      : { kind: "CONCURRENT_CONFLICT" as const };
  }

  async moveStop(input: {
    userId: string;
    positionId: string;
    move: StopMoveInput;
  }) {
    const current = await this.#owned(input.userId, input.positionId);
    if (!current) return { kind: "NOT_FOUND" as const };

    const result = moveUserStop(current, input.move);
    if (result.kind !== "APPLIED") {
      return result;
    }

    const saved = await this.#repository.savePositionCas({
      previousVersion: current.version,
      snapshot: result.position,
    });

    return saved
      ? { kind: "APPLIED" as const, position: saved }
      : { kind: "CONCURRENT_CONFLICT" as const };
  }

  async applyStop(input: {
    userId: string;
    positionId: string;
    stop: GlobalStopInput;
  }) {
    const current = await this.#owned(input.userId, input.positionId);
    if (!current) return { kind: "NOT_FOUND" as const };

    const result = applyGlobalStop(current, input.stop);
    if (result.kind === "STALE_OR_DUPLICATE") {
      return result;
    }

    const saved = await this.#repository.savePositionCas({
      previousVersion: current.version,
      snapshot: result.position,
    });

    return saved
      ? { kind: "APPLIED" as const, position: saved }
      : { kind: "CONCURRENT_CONFLICT" as const };
  }

  async manualExit(input: {
    userId: string;
    positionId: string;
    exit: ManualExitInput;
  }) {
    const current = await this.#owned(input.userId, input.positionId);
    if (!current) return { kind: "NOT_FOUND" as const };

    const next = applyManualExit(current, input.exit);
    const saved = await this.#repository.savePositionCas({
      previousVersion: current.version,
      snapshot: next,
    });

    return saved
      ? { kind: "APPLIED" as const, position: saved }
      : { kind: "CONCURRENT_CONFLICT" as const };
  }

  async #owned(
    userIdInput: string,
    positionIdInput: string,
  ): Promise<UserPositionSnapshot | null> {
    const userId = opaque(userIdInput, "userId");
    const positionId = opaque(positionIdInput, "positionId", 128);
    const position = await this.#repository.findOwnedPosition(userId, positionId);
    if (position && position.userId !== userId) {
      throw new Error("Accounting repository violated ownership boundary");
    }
    return position;
  }
}
