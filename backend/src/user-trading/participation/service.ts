import type { ParticipationRepository } from "./repository.js";
import type {
  FollowSignalResult,
  ParticipationClock,
  ParticipationIdFactory,
  UnfollowSignalResult,
  UserSignalParticipation,
} from "./types.js";

const LIVE_STATUSES = new Set(["FOLLOWING", "PLANNED", "ACTIVE"]);
const TERMINAL_STATUSES = new Set([
  "EXITED_EARLY",
  "COMPLETED",
  "STOPPED",
  "CANCELLED",
]);

function requireOpaqueId(value: string, field: string, maxLength = 256): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maxLength ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError(`${field} must be a bounded opaque identifier`);
  }

  return value;
}

function assertIsoTimestamp(value: string, field: string): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value) ||
    Number.isNaN(Date.parse(value))
  ) {
    throw new TypeError(`${field} must be a canonical UTC timestamp`);
  }
  return value;
}

function validateOwnedParticipation(
  participation: UserSignalParticipation,
  userId: string,
): UserSignalParticipation {
  if (participation.userId !== userId) {
    throw new Error("Participation repository violated ownership boundary");
  }
  return participation;
}

export class UserSignalParticipationService {
  readonly #repository: ParticipationRepository;
  readonly #clock: ParticipationClock;
  readonly #idFactory: ParticipationIdFactory;

  constructor(input: {
    repository: ParticipationRepository;
    clock: ParticipationClock;
    idFactory: ParticipationIdFactory;
  }) {
    this.#repository = input.repository;
    this.#clock = input.clock;
    this.#idFactory = input.idFactory;
  }

  async followSignal(userIdInput: string, signalIdInput: string): Promise<FollowSignalResult> {
    const userId = requireOpaqueId(userIdInput, "userId");
    const signalId = requireOpaqueId(signalIdInput, "signalId");

    const existing = await this.#repository.findLiveByUserSignal(userId, signalId);
    if (existing) {
      return {
        kind: "EXISTING",
        participation: validateOwnedParticipation(existing, userId),
      };
    }

    if (!(await this.#repository.signalExists(signalId))) {
      return { kind: "SIGNAL_NOT_FOUND" };
    }

    const now = assertIsoTimestamp(this.#clock.nowIso(), "clock.nowIso()");
    const participationId = requireOpaqueId(
      this.#idFactory.createParticipationId(),
      "participationId",
      128,
    );

    const created = await this.#repository.tryCreateFollowing({
      participationId,
      userId,
      signalId,
      subscribedAt: now,
    });

    if (created) {
      return {
        kind: "CREATED",
        participation: validateOwnedParticipation(created, userId),
      };
    }

    // Concurrency-safe idempotency: another request may have won the partial
    // unique (user_id, signal_id) live-participation race.
    const winner = await this.#repository.findLiveByUserSignal(userId, signalId);
    if (!winner) {
      throw new Error("Participation create lost race without a durable live winner");
    }

    return {
      kind: "EXISTING",
      participation: validateOwnedParticipation(winner, userId),
    };
  }

  async unfollowParticipation(
    userIdInput: string,
    participationIdInput: string,
  ): Promise<UnfollowSignalResult> {
    const userId = requireOpaqueId(userIdInput, "userId");
    const participationId = requireOpaqueId(
      participationIdInput,
      "participationId",
      128,
    );

    const current = await this.#repository.findOwnedById(userId, participationId);
    if (!current) {
      // Missing and foreign ownership intentionally collapse to one result.
      return { kind: "NOT_FOUND" };
    }

    validateOwnedParticipation(current, userId);

    if (current.status === "ACTIVE") {
      return {
        kind: "ACTIVE_CONFLICT",
        participation: current,
      };
    }

    if (TERMINAL_STATUSES.has(current.status)) {
      return {
        kind: "ALREADY_TERMINAL",
        participation: current,
      };
    }

    if (!LIVE_STATUSES.has(current.status)) {
      throw new Error(`Unsupported participation state: ${current.status}`);
    }

    const now = assertIsoTimestamp(this.#clock.nowIso(), "clock.nowIso()");
    const cancelled = await this.#repository.transitionOwned(
      userId,
      participationId,
      ["FOLLOWING", "PLANNED"],
      "CANCELLED",
      now,
      now,
    );

    if (cancelled) {
      return {
        kind: "CANCELLED",
        participation: validateOwnedParticipation(cancelled, userId),
      };
    }

    // A concurrent transition won. Re-read through the same ownership scope
    // and return a finite result instead of fabricating cancellation.
    const winner = await this.#repository.findOwnedById(userId, participationId);
    if (!winner) {
      return { kind: "NOT_FOUND" };
    }

    validateOwnedParticipation(winner, userId);

    if (winner.status === "ACTIVE") {
      return {
        kind: "ACTIVE_CONFLICT",
        participation: winner,
      };
    }

    if (TERMINAL_STATUSES.has(winner.status)) {
      return {
        kind: "ALREADY_TERMINAL",
        participation: winner,
      };
    }

    throw new Error("Participation unfollow race ended in unsupported non-terminal state");
  }
}
