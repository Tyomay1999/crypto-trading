import type {
  EntryContext,
  PositionAccountingRepository,
} from "./repository.js";
import type {
  GlobalLifecycleState,
  PositionDirection,
  StopBasis,
  UserPositionSnapshot,
  UserPositionState,
} from "./types.js";

interface QueryResultLike<Row> {
  rows: Row[];
}

export interface AccountingTransactionClient {
  query<Row = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResultLike<Row>>;
  release(): void;
}

export interface AccountingDatabase {
  connect(): Promise<AccountingTransactionClient>;
  query<Row = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResultLike<Row>>;
}

interface EntryRow {
  participation_id: string;
  user_id: string;
  signal_id: string;
  participation_status: string;
  selected_position_notional: string;
  selected_stop_price: string;
}

interface PositionRow {
  position_id: string;
  participation_id: string;
  user_id: string;
  signal_id: string;
  direction: PositionDirection;
  state: UserPositionState;
  actual_entry_price: string;
  entered_at: string | Date;
  initial_quantity: string;
  initial_notional: string;
  remaining_fraction: string;
  realized_fraction: string;
  realized_pnl: string;
  selected_stop_price: string;
  stop_basis: StopBasis;
  last_global_sequence: string;
  last_global_state: GlobalLifecycleState;
  version: string;
  terminal_at: string | Date | null;
}

function iso(value: string | Date): string {
  return typeof value === "string" ? new Date(value).toISOString() : value.toISOString();
}

function mapPosition(row: PositionRow): UserPositionSnapshot {
  return {
    positionId: row.position_id,
    participationId: row.participation_id,
    userId: row.user_id,
    signalId: row.signal_id,
    direction: row.direction,
    state: row.state,
    actualEntryPrice: row.actual_entry_price,
    enteredAt: iso(row.entered_at),
    initialQuantity: row.initial_quantity,
    initialNotional: row.initial_notional,
    remainingFraction: row.remaining_fraction,
    realizedFraction: row.realized_fraction,
    realizedPnl: row.realized_pnl,
    selectedStopPrice: row.selected_stop_price,
    stopBasis: row.stop_basis,
    lastGlobalSequence: row.last_global_sequence,
    lastGlobalState: row.last_global_state,
    version: row.version,
    terminalAt: row.terminal_at === null ? null : iso(row.terminal_at),
  };
}

const POSITION_COLUMNS = `
  position_id,
  participation_id,
  user_id,
  signal_id,
  direction,
  state,
  actual_entry_price,
  entered_at,
  initial_quantity,
  initial_notional,
  remaining_fraction,
  realized_fraction,
  realized_pnl,
  selected_stop_price,
  stop_basis,
  last_global_sequence,
  last_global_state,
  version,
  terminal_at
`;

export class PostgresPositionAccountingRepository
  implements PositionAccountingRepository
{
  readonly #db: AccountingDatabase;

  constructor(db: AccountingDatabase) {
    this.#db = db;
  }

  async findEntryContext(
    userId: string,
    participationId: string,
  ): Promise<EntryContext | null> {
    const result = await this.#db.query<EntryRow>(
      `
        SELECT
          p.participation_id,
          p.user_id,
          p.signal_id,
          p.status AS participation_status,
          t.selected_position_notional,
          t.selected_stop_price
        FROM app.user_signal_participation p
        JOIN app.user_trade_plan t
          ON t.participation_id = p.participation_id
         AND t.user_id = p.user_id
         AND t.signal_id = p.signal_id
        WHERE p.user_id = $1
          AND p.participation_id = $2
          AND t.locked_at IS NULL
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
          participationStatus: row.participation_status,
          selectedPositionNotional: row.selected_position_notional,
          selectedStopPrice: row.selected_stop_price,
        }
      : null;
  }

  async createPosition(input: {
    snapshot: UserPositionSnapshot;
  }): Promise<UserPositionSnapshot | null> {
    const client = await this.#db.connect();
    const p = input.snapshot;

    try {
      await client.query("BEGIN");

      const participation = await client.query<{ status: string }>(
        `
          SELECT status
          FROM app.user_signal_participation
          WHERE user_id = $1
            AND participation_id = $2
            AND signal_id = $3
          FOR UPDATE
        `,
        [p.userId, p.participationId, p.signalId],
      );

      if (!["PLANNED"].includes(participation.rows[0]?.status ?? "")) {
        await client.query("ROLLBACK");
        return null;
      }

      const inserted = await client.query<PositionRow>(
        `
          INSERT INTO app.user_position (
            position_id,
            participation_id,
            user_id,
            signal_id,
            direction,
            state,
            actual_entry_price,
            entered_at,
            initial_quantity,
            initial_notional,
            remaining_fraction,
            realized_fraction,
            realized_pnl,
            selected_stop_price,
            stop_basis,
            last_global_sequence,
            last_global_state,
            version,
            created_at,
            updated_at,
            terminal_at
          )
          VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8::timestamptz,
            $9, $10, $11, $12, $13, $14, $15,
            $16::bigint, $17, $18::bigint,
            $8::timestamptz, $8::timestamptz, NULL
          )
          ON CONFLICT (participation_id) DO NOTHING
          RETURNING ${POSITION_COLUMNS}
        `,
        [
          p.positionId,
          p.participationId,
          p.userId,
          p.signalId,
          p.direction,
          p.state,
          p.actualEntryPrice,
          p.enteredAt,
          p.initialQuantity,
          p.initialNotional,
          p.remainingFraction,
          p.realizedFraction,
          p.realizedPnl,
          p.selectedStopPrice,
          p.stopBasis,
          p.lastGlobalSequence,
          p.lastGlobalState,
          p.version,
        ],
      );

      const row = inserted.rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        return null;
      }

      const updated = await client.query(
        `
          UPDATE app.user_signal_participation
          SET status = 'ACTIVE',
              updated_at = $4::timestamptz
          WHERE user_id = $1
            AND participation_id = $2
            AND signal_id = $3
            AND status = 'PLANNED'
          RETURNING participation_id
        `,
        [p.userId, p.participationId, p.signalId, p.enteredAt],
      );

      if (!updated.rows[0]) {
        await client.query("ROLLBACK");
        return null;
      }

      await client.query("COMMIT");
      return mapPosition(row);
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {}
      throw error;
    } finally {
      client.release();
    }
  }

  async findOwnedPosition(
    userId: string,
    positionId: string,
  ): Promise<UserPositionSnapshot | null> {
    const result = await this.#db.query<PositionRow>(
      `
        SELECT ${POSITION_COLUMNS}
        FROM app.user_position
        WHERE user_id = $1
          AND position_id = $2
        LIMIT 1
      `,
      [userId, positionId],
    );
    const row = result.rows[0];
    return row ? mapPosition(row) : null;
  }

  async savePositionCas(input: {
    previousVersion: string;
    snapshot: UserPositionSnapshot;
  }): Promise<UserPositionSnapshot | null> {
    const client = await this.#db.connect();
    const p = input.snapshot;

    try {
      await client.query("BEGIN");

      const updated = await client.query<PositionRow>(
        `
          UPDATE app.user_position
          SET
            state = $4,
            remaining_fraction = $5,
            realized_fraction = $6,
            realized_pnl = $7,
            selected_stop_price = $8,
            stop_basis = $9,
            last_global_sequence = $10::bigint,
            last_global_state = $11,
            version = $12::bigint,
            updated_at = clock_timestamp(),
            terminal_at = $13::timestamptz
          WHERE user_id = $1
            AND position_id = $2
            AND participation_id = $3
            AND version = $14::bigint
          RETURNING ${POSITION_COLUMNS}
        `,
        [
          p.userId,
          p.positionId,
          p.participationId,
          p.state,
          p.remainingFraction,
          p.realizedFraction,
          p.realizedPnl,
          p.selectedStopPrice,
          p.stopBasis,
          p.lastGlobalSequence,
          p.lastGlobalState,
          p.version,
          p.terminalAt,
          input.previousVersion,
        ],
      );

      const row = updated.rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        return null;
      }

      if (["EXITED_EARLY", "COMPLETED", "STOPPED"].includes(p.state)) {
        const status =
          p.state === "EXITED_EARLY"
            ? "EXITED_EARLY"
            : p.state === "COMPLETED"
              ? "COMPLETED"
              : "STOPPED";

        const participation = await client.query(
          `
            UPDATE app.user_signal_participation
            SET status = $4,
                updated_at = clock_timestamp()
            WHERE user_id = $1
              AND participation_id = $2
              AND signal_id = $3
              AND status = 'ACTIVE'
            RETURNING participation_id
          `,
          [p.userId, p.participationId, p.signalId, status],
        );

        if (!participation.rows[0]) {
          await client.query("ROLLBACK");
          return null;
        }
      }

      await client.query("COMMIT");
      return mapPosition(row);
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {}
      throw error;
    } finally {
      client.release();
    }
  }
}
