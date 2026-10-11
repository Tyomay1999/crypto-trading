import type {
  PlanningParticipation,
  SaveTradePlanInput,
  TradePlanningRepository,
} from "./repository.js";
import type { PersistedTradePlan } from "./types.js";

interface QueryResultLike<Row> {
  rows: Row[];
}

export interface PlanningTransactionClient {
  query<Row = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResultLike<Row>>;
  release(): void;
}

export interface PlanningDatabase {
  connect(): Promise<PlanningTransactionClient>;
  query<Row = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResultLike<Row>>;
}

interface ParticipationRow {
  participation_id: string;
  user_id: string;
  signal_id: string;
  status: string;
}

interface PlanRow {
  trade_plan_id: string;
  balance_snapshot_id: string;
  participation_id: string;
  user_id: string;
  signal_id: string;
  planned_entry_price: string;
  original_signal_stop_price: string;
  selected_stop_price: string;
  suggested_position_notional: string;
  selected_position_notional: string;
  risk_amount: string;
  risk_fraction: string;
  suggested_leverage: string;
  leverage: string;
  required_margin: string;
  margin_mode: "ISOLATED" | "CROSS";
  value_source: "SYSTEM_SUGGESTED" | "USER_OVERRIDE";
  created_at: string | Date;
  updated_at: string | Date;
  locked_at: string | Date | null;
}

function iso(value: string | Date): string {
  return typeof value === "string" ? new Date(value).toISOString() : value.toISOString();
}

function mapPlan(row: PlanRow): PersistedTradePlan {
  return {
    tradePlanId: row.trade_plan_id,
    balanceSnapshotId: row.balance_snapshot_id,
    participationId: row.participation_id,
    userId: row.user_id,
    signalId: row.signal_id,
    plannedEntryPrice: row.planned_entry_price,
    originalSignalStopPrice: row.original_signal_stop_price,
    selectedStopPrice: row.selected_stop_price,
    suggestedPositionNotional: row.suggested_position_notional,
    selectedPositionNotional: row.selected_position_notional,
    riskAmount: row.risk_amount,
    riskFraction: row.risk_fraction,
    suggestedLeverage: row.suggested_leverage,
    leverage: row.leverage,
    requiredMargin: row.required_margin,
    marginMode: row.margin_mode,
    valueSource: row.value_source,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    lockedAt: row.locked_at === null ? null : iso(row.locked_at),
  };
}

export class PostgresTradePlanningRepository implements TradePlanningRepository {
  readonly #db: PlanningDatabase;

  constructor(db: PlanningDatabase) {
    this.#db = db;
  }

  async findOwnedParticipation(
    userId: string,
    participationId: string,
  ): Promise<PlanningParticipation | null> {
    const result = await this.#db.query<ParticipationRow>(
      `
        SELECT participation_id, user_id, signal_id, status
        FROM app.user_signal_participation
        WHERE user_id = $1
          AND participation_id = $2
        LIMIT 1
      `,
      [userId, participationId],
    );

    const row = result.rows[0];
    return row
      ? {
          participationId: row.participation_id,
          userId: row.user_id,
          signalId: row.signal_id,
          status: row.status,
        }
      : null;
  }

  async savePlan(input: SaveTradePlanInput): Promise<PersistedTradePlan | null> {
    const client = await this.#db.connect();

    try {
      await client.query("BEGIN");

      const locked = await client.query<ParticipationRow>(
        `
          SELECT participation_id, user_id, signal_id, status
          FROM app.user_signal_participation
          WHERE user_id = $1
            AND participation_id = $2
          FOR UPDATE
        `,
        [input.participation.userId, input.participation.participationId],
      );

      const current = locked.rows[0];
      if (
        !current ||
        current.signal_id !== input.participation.signalId ||
        !["FOLLOWING", "PLANNED"].includes(current.status)
      ) {
        await client.query("ROLLBACK");
        return null;
      }

      await client.query(
        `
          INSERT INTO app.user_balance_snapshot (
            balance_snapshot_id,
            participation_id,
            user_id,
            signal_id,
            provider_kind,
            exchange,
            account_reference,
            currency,
            available_balance,
            equity,
            observed_at,
            created_at
          )
          VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
            $11::timestamptz, $11::timestamptz
          )
        `,
        [
          input.balanceSnapshotId,
          current.participation_id,
          current.user_id,
          current.signal_id,
          input.snapshot.providerKind,
          input.snapshot.exchange,
          input.snapshot.accountReference,
          input.snapshot.currency,
          input.snapshot.availableBalance,
          input.snapshot.equity,
          input.snapshot.observedAt,
        ],
      );

      const plan = await client.query<PlanRow>(
        `
          INSERT INTO app.user_trade_plan (
            trade_plan_id,
            participation_id,
            user_id,
            signal_id,
            entry_basis,
            planned_entry_price,
            original_signal_stop_price,
            selected_stop_price,
            suggested_position_notional,
            selected_position_notional,
            risk_amount,
            risk_fraction,
            leverage,
            margin_mode,
            value_source,
            created_at,
            updated_at,
            locked_at,
            balance_snapshot_id,
            suggested_leverage,
            required_margin
          )
          VALUES (
            $1, $2, $3, $4, 'SIGNAL_REFERENCE',
            $5, $6, $6, $7, $8, $9, $10, $11, $12, $13,
            $14::timestamptz, $14::timestamptz, NULL,
            $15, $16, $17
          )
          ON CONFLICT (participation_id)
          DO UPDATE SET
            planned_entry_price = EXCLUDED.planned_entry_price,
            original_signal_stop_price = EXCLUDED.original_signal_stop_price,
            selected_stop_price = EXCLUDED.selected_stop_price,
            suggested_position_notional = EXCLUDED.suggested_position_notional,
            selected_position_notional = EXCLUDED.selected_position_notional,
            risk_amount = EXCLUDED.risk_amount,
            risk_fraction = EXCLUDED.risk_fraction,
            leverage = EXCLUDED.leverage,
            margin_mode = EXCLUDED.margin_mode,
            value_source = EXCLUDED.value_source,
            updated_at = EXCLUDED.updated_at,
            balance_snapshot_id = EXCLUDED.balance_snapshot_id,
            suggested_leverage = EXCLUDED.suggested_leverage,
            required_margin = EXCLUDED.required_margin
          WHERE app.user_trade_plan.locked_at IS NULL
            AND app.user_trade_plan.user_id = EXCLUDED.user_id
            AND app.user_trade_plan.signal_id = EXCLUDED.signal_id
          RETURNING
            trade_plan_id,
            balance_snapshot_id,
            participation_id,
            user_id,
            signal_id,
            planned_entry_price,
            original_signal_stop_price,
            selected_stop_price,
            suggested_position_notional,
            selected_position_notional,
            risk_amount,
            risk_fraction,
            suggested_leverage,
            leverage,
            required_margin,
            margin_mode,
            value_source,
            created_at,
            updated_at,
            locked_at
        `,
        [
          input.tradePlanId,
          current.participation_id,
          current.user_id,
          current.signal_id,
          input.entryPrice,
          input.originalSignalStopPrice,
          input.recommendation.suggestedPositionNotional,
          input.recommendation.selectedPositionNotional,
          input.recommendation.selectedRiskAmount,
          input.recommendation.selectedRiskFraction,
          input.recommendation.selectedLeverage,
          input.recommendation.marginMode,
          input.recommendation.valueSource,
          input.observedAt,
          input.balanceSnapshotId,
          input.recommendation.suggestedLeverage,
          input.recommendation.selectedRequiredMargin,
        ],
      );

      const saved = plan.rows[0];
      if (!saved) {
        await client.query("ROLLBACK");
        return null;
      }

      const participationUpdate = await client.query<ParticipationRow>(
        `
          UPDATE app.user_signal_participation
          SET status = 'PLANNED',
              updated_at = $3::timestamptz
          WHERE user_id = $1
            AND participation_id = $2
            AND status IN ('FOLLOWING', 'PLANNED')
          RETURNING participation_id, user_id, signal_id, status
        `,
        [current.user_id, current.participation_id, input.observedAt],
      );

      if (!participationUpdate.rows[0]) {
        await client.query("ROLLBACK");
        return null;
      }

      await client.query("COMMIT");
      return mapPlan(saved);
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original transaction failure.
      }
      throw error;
    } finally {
      client.release();
    }
  }
}
