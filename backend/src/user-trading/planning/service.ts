import type { ExchangeAccountSnapshotProvider } from "./account-snapshot-provider.js";
import { calculateTradeRecommendation } from "./risk-engine.js";
import type { TradePlanningRepository } from "./repository.js";
import type {
  AccountSnapshotRequest,
  BuildTradePlanResult,
  RiskPolicy,
  SignalPlanningInput,
  UserPlanOverride,
} from "./types.js";

export interface PlanningClock {
  nowIso(): string;
}

export interface PlanningIdFactory {
  createTradePlanId(): string;
  createBalanceSnapshotId(): string;
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

function canonicalUtc(value: string, field: string): string {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value) ||
    Number.isNaN(Date.parse(value))
  ) {
    throw new TypeError(`${field} must be a canonical UTC timestamp`);
  }
  return value;
}

export class UserTradePlanningService {
  readonly #repository: TradePlanningRepository;
  readonly #accountProvider: ExchangeAccountSnapshotProvider;
  readonly #clock: PlanningClock;
  readonly #ids: PlanningIdFactory;

  constructor(input: {
    repository: TradePlanningRepository;
    accountProvider: ExchangeAccountSnapshotProvider;
    clock: PlanningClock;
    idFactory: PlanningIdFactory;
  }) {
    this.#repository = input.repository;
    this.#accountProvider = input.accountProvider;
    this.#clock = input.clock;
    this.#ids = input.idFactory;
  }

  async buildPlan(input: {
    userId: string;
    participationId: string;
    signal: SignalPlanningInput;
    account: Omit<AccountSnapshotRequest, "userId">;
    policy: RiskPolicy;
    override?: UserPlanOverride;
  }): Promise<BuildTradePlanResult> {
    const userId = opaque(input.userId, "userId");
    const participationId = opaque(input.participationId, "participationId", 128);

    const participation = await this.#repository.findOwnedParticipation(
      userId,
      participationId,
    );

    if (!participation || participation.signalId !== input.signal.signalId) {
      return { kind: "NOT_FOUND" };
    }

    if (!["FOLLOWING", "PLANNED"].includes(participation.status)) {
      return {
        kind: "STATE_CONFLICT",
        status: participation.status,
      };
    }

    const snapshot = await this.#accountProvider.getSnapshot({
      userId,
      ...input.account,
    });

    const recommendation = calculateTradeRecommendation({
      account: snapshot,
      signal: input.signal,
      policy: input.policy,
      override: input.override,
    });

    const observedAt = canonicalUtc(this.#clock.nowIso(), "clock.nowIso()");
    const balanceSnapshotId = opaque(
      this.#ids.createBalanceSnapshotId(),
      "balanceSnapshotId",
      128,
    );
    const tradePlanId = opaque(
      this.#ids.createTradePlanId(),
      "tradePlanId",
      128,
    );

    const plan = await this.#repository.savePlan({
      tradePlanId,
      balanceSnapshotId,
      participation,
      snapshot,
      entryPrice: input.signal.entryPrice,
      originalSignalStopPrice: input.signal.stopPrice,
      recommendation,
      observedAt,
    });

    if (!plan) {
      return {
        kind: "STATE_CONFLICT",
        status: "CONCURRENT_TRANSITION",
      };
    }

    return {
      kind: "PLANNED",
      plan,
      snapshot: {
        ...snapshot,
        balanceSnapshotId,
      },
      recommendation,
    };
  }
}
