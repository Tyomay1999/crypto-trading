import type {
  GlobalLifecycleState,
  PositionDirection,
  StopBasis,
  UserPositionSnapshot,
  UserPositionState,
} from "../accounting/types.js";
import type {
  UserPositionEventRecord,
  UserPositionEventType,
  UserPositionOutcomeRecord,
  UserTerminalReason,
} from "../ledger/types.js";
import type {
  UserTradingApiReadRepository,
  UserTradingParticipationView,
  UserTradingPositionDetail,
} from "./types.js";

interface QueryResultLike<Row> { rows: Row[]; }
export interface UserTradingReadDatabase {
  query<Row = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResultLike<Row>>;
}

interface ParticipationRow {
  participation_id: string;
  signal_id: string;
  status: string;
  subscribed_at: string | Date;
  unsubscribed_at: string | Date | null;
}
interface PositionRow {
  position_id: string; participation_id: string; user_id: string; signal_id: string;
  direction: PositionDirection; state: UserPositionState;
  actual_entry_price: string; entered_at: string | Date;
  initial_quantity: string; initial_notional: string;
  remaining_fraction: string; realized_fraction: string; realized_pnl: string;
  selected_stop_price: string; stop_basis: StopBasis;
  last_global_sequence: string; last_global_state: GlobalLifecycleState;
  version: string; terminal_at: string | Date | null;
}
interface EventRow {
  event_id: string; position_id: string; participation_id: string;
  user_id: string; signal_id: string; event_type: UserPositionEventType;
  event_identity: string; global_event_identity: string | null;
  global_sequence: string | null; occurred_at: string | Date;
  observed_at: string | Date; payload: Record<string, unknown>;
  created_at: string | Date;
}
interface OutcomeRow {
  position_id: string; participation_id: string; user_id: string; signal_id: string;
  terminal_reason: UserTerminalReason;
  user_terminal_state: "EXITED_EARLY" | "COMPLETED" | "STOPPED" | "CANCELLED";
  actual_exit_price: string | null; realized_pnl: string; realized_return: string;
  realized_fraction: string; fees: string; completed_at: string | Date;
}

function iso(value: string | Date): string {
  return typeof value === "string" ? new Date(value).toISOString() : value.toISOString();
}
function mapPosition(r: PositionRow): UserPositionSnapshot {
  return {
    positionId:r.position_id, participationId:r.participation_id, userId:r.user_id,
    signalId:r.signal_id, direction:r.direction, state:r.state,
    actualEntryPrice:r.actual_entry_price, enteredAt:iso(r.entered_at),
    initialQuantity:r.initial_quantity, initialNotional:r.initial_notional,
    remainingFraction:r.remaining_fraction, realizedFraction:r.realized_fraction,
    realizedPnl:r.realized_pnl, selectedStopPrice:r.selected_stop_price,
    stopBasis:r.stop_basis, lastGlobalSequence:r.last_global_sequence,
    lastGlobalState:r.last_global_state, version:r.version,
    terminalAt:r.terminal_at === null ? null : iso(r.terminal_at),
  };
}
function mapEvent(r: EventRow): UserPositionEventRecord {
  return {
    eventId:r.event_id, positionId:r.position_id, participationId:r.participation_id,
    userId:r.user_id, signalId:r.signal_id, eventType:r.event_type,
    eventIdentity:r.event_identity, globalEventIdentity:r.global_event_identity,
    globalSequence:r.global_sequence, occurredAt:iso(r.occurred_at),
    observedAt:iso(r.observed_at), payload:r.payload, createdAt:iso(r.created_at),
  };
}
function mapOutcome(r: OutcomeRow): UserPositionOutcomeRecord {
  return {
    positionId:r.position_id, participationId:r.participation_id, userId:r.user_id,
    signalId:r.signal_id, terminalReason:r.terminal_reason,
    userTerminalState:r.user_terminal_state, actualExitPrice:r.actual_exit_price,
    realizedPnl:r.realized_pnl, realizedReturn:r.realized_return,
    realizedFraction:r.realized_fraction, fees:r.fees, completedAt:iso(r.completed_at),
  };
}

export class PostgresUserTradingApiReadRepository
  implements UserTradingApiReadRepository {
  readonly #db: UserTradingReadDatabase;
  constructor(db: UserTradingReadDatabase) { this.#db = db; }

  async listParticipations(userId: string, limit: number) {
    const result = await this.#db.query<ParticipationRow>(
      `SELECT participation_id, signal_id, status, subscribed_at, unsubscribed_at
       FROM app.user_signal_participation
       WHERE user_id = $1
       ORDER BY subscribed_at DESC, participation_id DESC
       LIMIT $2`,
      [userId, limit],
    );
    return result.rows.map((r) => ({
      participationId:r.participation_id, signalId:r.signal_id, state:r.status,
      subscribedAt:iso(r.subscribed_at),
      unsubscribedAt:r.unsubscribed_at === null ? null : iso(r.unsubscribed_at),
    }));
  }

  async getPositionDetail(userId: string, positionId: string):
    Promise<UserTradingPositionDetail | null> {
    const p = await this.#db.query<PositionRow>(
      `SELECT position_id, participation_id, user_id, signal_id, direction, state,
              actual_entry_price, entered_at, initial_quantity, initial_notional,
              remaining_fraction, realized_fraction, realized_pnl,
              selected_stop_price, stop_basis, last_global_sequence,
              last_global_state, version, terminal_at
       FROM app.user_position
       WHERE user_id = $1 AND position_id = $2
       LIMIT 1`,
      [userId, positionId],
    );
    if (!p.rows[0]) return null;

    const e = await this.#db.query<EventRow>(
      `SELECT event_id, position_id, participation_id, user_id, signal_id,
              event_type, event_identity, global_event_identity, global_sequence,
              occurred_at, observed_at, payload, created_at
       FROM app.user_position_event
       WHERE user_id = $1 AND position_id = $2
       ORDER BY occurred_at ASC, created_at ASC, event_id ASC`,
      [userId, positionId],
    );

    const o = await this.#db.query<OutcomeRow>(
      `SELECT position_id, participation_id, user_id, signal_id,
              terminal_reason, user_terminal_state, actual_exit_price,
              realized_pnl, realized_return, realized_fraction, fees, completed_at
       FROM app.user_position_outcome
       WHERE user_id = $1 AND position_id = $2
       LIMIT 1`,
      [userId, positionId],
    );

    return {
      position: mapPosition(p.rows[0]),
      events: e.rows.map(mapEvent),
      outcome: o.rows[0] ? mapOutcome(o.rows[0]) : null,
    };
  }
}
