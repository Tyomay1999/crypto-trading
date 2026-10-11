import type {
  ExchangeAccountSnapshot,
  PersistedTradePlan,
  TradeRecommendation,
} from "./types.js";

export interface PlanningParticipation {
  participationId: string;
  userId: string;
  signalId: string;
  status: string;
}

export interface SaveTradePlanInput {
  tradePlanId: string;
  balanceSnapshotId: string;
  participation: PlanningParticipation;
  snapshot: ExchangeAccountSnapshot;
  entryPrice: string;
  originalSignalStopPrice: string;
  recommendation: TradeRecommendation;
  observedAt: string;
}

export interface TradePlanningRepository {
  findOwnedParticipation(
    userId: string,
    participationId: string,
  ): Promise<PlanningParticipation | null>;

  savePlan(input: SaveTradePlanInput): Promise<PersistedTradePlan | null>;
}
