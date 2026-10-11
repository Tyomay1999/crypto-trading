import type { UserPositionSnapshot } from "../accounting/types.js";
import type {
  UserPositionEventRecord,
  UserPositionOutcomeRecord,
} from "../ledger/types.js";

export interface UserTradingParticipationView {
  participationId: string;
  signalId: string;
  state: string;
  subscribedAt: string;
  unsubscribedAt: string | null;
}

export interface UserTradingPositionDetail {
  position: UserPositionSnapshot;
  events: readonly UserPositionEventRecord[];
  outcome: UserPositionOutcomeRecord | null;
}

export interface UserTradingApiReadRepository {
  listParticipations(userId: string, limit: number):
    Promise<readonly UserTradingParticipationView[]>;
  getPositionDetail(userId: string, positionId: string):
    Promise<UserTradingPositionDetail | null>;
}
