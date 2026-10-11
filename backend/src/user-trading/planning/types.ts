export type TradeDirection = "LONG" | "SHORT";
export type MarginMode = "ISOLATED" | "CROSS";
export type PlanValueSource = "SYSTEM_SUGGESTED" | "USER_OVERRIDE";

export interface ExchangeAccountSnapshot {
  providerKind: string;
  exchange: string;
  accountReference: string | null;
  currency: string;
  availableBalance: string;
  equity: string | null;
  observedAt: string;
}

export interface AccountSnapshotRequest {
  userId: string;
  exchange: string;
  accountReference: string | null;
  currency: string;
}

export interface SignalPlanningInput {
  signalId: string;
  direction: TradeDirection;
  entryPrice: string;
  stopPrice: string;
}

export interface RiskPolicy {
  targetRiskFraction: string;
  reserveFraction: string;
  maxLeverage: string;
  marginMode: MarginMode;
}

export interface UserPlanOverride {
  selectedPositionNotional?: string;
  selectedLeverage?: string;
  marginMode?: MarginMode;
}

export interface TradeRecommendation {
  availableBalance: string;
  targetRiskAmount: string;
  stopDistanceFraction: string;
  usableMargin: string;
  riskBasedNotional: string;
  marginLimitedNotional: string;
  suggestedPositionNotional: string;
  suggestedLeverage: string;
  suggestedRequiredMargin: string;
  selectedPositionNotional: string;
  selectedLeverage: string;
  selectedRequiredMargin: string;
  selectedRiskAmount: string;
  selectedRiskFraction: string;
  marginMode: MarginMode;
  valueSource: PlanValueSource;
}

export interface PersistedTradePlan {
  tradePlanId: string;
  balanceSnapshotId: string;
  participationId: string;
  userId: string;
  signalId: string;
  plannedEntryPrice: string;
  originalSignalStopPrice: string;
  selectedStopPrice: string;
  suggestedPositionNotional: string;
  selectedPositionNotional: string;
  riskAmount: string;
  riskFraction: string;
  suggestedLeverage: string;
  leverage: string;
  requiredMargin: string;
  marginMode: MarginMode;
  valueSource: PlanValueSource;
  createdAt: string;
  updatedAt: string;
  lockedAt: string | null;
}

export type BuildTradePlanResult =
  | {
      kind: "PLANNED";
      plan: PersistedTradePlan;
      snapshot: ExchangeAccountSnapshot & { balanceSnapshotId: string };
      recommendation: TradeRecommendation;
    }
  | {
      kind: "NOT_FOUND";
    }
  | {
      kind: "STATE_CONFLICT";
      status: string;
    };
