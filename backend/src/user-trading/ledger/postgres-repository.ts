import type {
  GlobalLifecycleState,
  PositionDirection,
  StopBasis,
  UserPositionSnapshot,
  UserPositionState,
} from "../accounting/types.js";
import {
  buildTerminalOutcome,
} from "./outcome.js";
import type {
  UserTradingLedgerRepository,
} from "./repository.js";
import type {
  LedgerCommitResult,
  LedgerEventDraft,
  TerminalOutcomeDraft,
  UserPositionEventRecord,
  UserPositionEventType,
  UserPositionOutcomeRecord,
  UserTerminalReason,
} from "./types.js";

interface QueryResultLike<Row> {
  rows: Row[];
}

export interface LedgerTransactionClient {
  query<Row = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResultLike<Row>>;
  release(): void;
}

export interface LedgerDatabase {
  connect(): Promise<LedgerTransactionClient>;
  query<Row = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResultLike<Row>>;
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

interface EventRow {
  event_id: string;
  position_id: string;
  participation_id: string;
  user_id: string;
  signal_id: string;
  event_type: UserPositionEventType;
  event_identity: string;
  global_event_identity: string | null;
  global_sequence: string | null;
  occurred_at: string | Date;
  observed_at: string | Date;
  payload: Record<string, unknown>;
  created_at: string | Date;
}

interface OutcomeRow {
  position_id: string;
  participation_id: string;
  user_id: string;
  signal_id: string;
  terminal_reason: UserTerminalReason;
  user_terminal_state: "EXITED_EARLY" | "COMPLETED" | "STOPPED" | "CANCELLED";
  actual_exit_price: string | null;
  realized_pnl: string;
  realized_return: string;
  realized_fraction: string;
  fees: string;
  completed_at: string | Date;
}

function iso(value: string | Date): string {
  return typeof value === "string" ? new Date(value).toISOString() : value.toISOString();
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

const EVENT_COLUMNS = `
  event_id,
  position_id,
  participation_id,
  user_id,
  signal_id,
  event_type,
  event_identity,
  global_event_identity,
  global_sequence,
  occurred_at,
  observed_at,
  payload,
  created_at
`;

const OUTCOME_COLUMNS = `
  position_id,
  participation_id,
  user_id,
  signal_id,
  terminal_reason,
  user_terminal_state,
  actual_exit_price,
  realized_pnl,
  realized_return,
  realized_fraction,
  fees,
  completed_at
`;

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

function mapEvent(row: EventRow): UserPositionEventRecord {
  return {
    eventId: row.event_id,
    positionId: row.position_id,
    participationId: row.participation_id,
    userId: row.user_id,
    signalId: row.signal_id,
    eventType: row.event_type,
    eventIdentity: row.event_identity,
    globalEventIdentity: row.global_event_identity,
    globalSequence: row.global_sequence,
    occurredAt: iso(row.occurred_at),
    observedAt: iso(row.observed_at),
    payload: row.payload,
    createdAt: iso(row.created_at),
  };
}

function mapOutcome(row: OutcomeRow): UserPositionOutcomeRecord {
  return {
    positionId: row.position_id,
    participationId: row.participation_id,
    userId: row.user_id,
    signalId: row.signal_id,
    terminalReason: row.terminal_reason,
    userTerminalState: row.user_terminal_state,
    actualExitPrice: row.actual_exit_price,
    realizedPnl: row.realized_pnl,
    realizedReturn: row.realized_return,
    realizedFraction: row.realized_fraction,
    fees: row.fees,
    completedAt: iso(row.completed_at),
  };
}

async function selectOutcome(
  client: Pick<LedgerTransactionClient, "query">,
  userId: string,
  positionId: string,
): Promise<UserPositionOutcomeRecord | null> {
  const result = await client.query<OutcomeRow>(
    `
      SELECT ${OUTCOME_COLUMNS}
      FROM app.user_position_outcome
      WHERE user_id = $1
        AND position_id = $2
      LIMIT 1
    `,
    [userId, positionId],
  );
  return result.rows[0] ? mapOutcome(result.rows[0]) : null;
}

async function selectEvent(
  client: Pick<LedgerTransactionClient, "query">,
  userId: string,
  positionId: string,
  eventIdentity: string,
): Promise<UserPositionEventRecord | null> {
  const result = await client.query<EventRow>(
    `
      SELECT ${EVENT_COLUMNS}
      FROM app.user_position_event
      WHERE user_id = $1
        AND position_id = $2
        AND event_identity = $3
      LIMIT 1
    `,
    [userId, positionId, eventIdentity],
  );
  return result.rows[0] ? mapEvent(result.rows[0]) : null;
}

export class PostgresUserTradingLedgerRepository
  implements UserTradingLedgerRepository
{
  readonly #db: LedgerDatabase;

  constructor(db: LedgerDatabase) {
    this.#db = db;
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
    return result.rows[0] ? mapPosition(result.rows[0]) : null;
  }

  async findEventByIdentity(
    userId: string,
    positionId: string,
    eventIdentity: string,
  ) {
    const event = await selectEvent(
      this.#db as unknown as LedgerTransactionClient,
      userId,
      positionId,
      eventIdentity,
    );
    if (!event) return null;
    const outcome = await selectOutcome(
      this.#db as unknown as LedgerTransactionClient,
      userId,
      positionId,
    );
    return { event, outcome };
  }

  async commitMutation(input: {
    userId: string;
    expectedVersion: string;
    nextPosition: UserPositionSnapshot;
    event: LedgerEventDraft;
    terminalOutcome: TerminalOutcomeDraft | null;
  }): Promise<LedgerCommitResult> {
    const client = await this.#db.connect();

    try {
      await client.query("BEGIN");

      const locked = await client.query<PositionRow>(
        `
          SELECT ${POSITION_COLUMNS}
          FROM app.user_position
          WHERE user_id = $1
            AND position_id = $2
          FOR UPDATE
        `,
        [input.userId, input.nextPosition.positionId],
      );

      const currentRow = locked.rows[0];
      if (!currentRow) {
        await client.query("ROLLBACK");
        return { kind: "NOT_FOUND" };
      }

      const current = mapPosition(currentRow);

      const duplicate = await selectEvent(
        client,
        input.userId,
        current.positionId,
        input.event.eventIdentity,
      );

      if (duplicate) {
        const outcome = await selectOutcome(
          client,
          input.userId,
          current.positionId,
        );
        await client.query("COMMIT");
        return {
          kind: "IDEMPOTENT_REPLAY",
          position: current,
          event: duplicate,
          outcome,
        };
      }

      if (current.version !== input.expectedVersion) {
        await client.query("ROLLBACK");
        return { kind: "CONCURRENT_CONFLICT" };
      }

      if (
        ["EXITED_EARLY", "COMPLETED", "STOPPED", "CANCELLED"].includes(
          current.state,
        )
      ) {
        await client.query("ROLLBACK");
        return { kind: "TERMINAL_CONFLICT" };
      }

      const p = input.nextPosition;

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
          input.expectedVersion,
        ],
      );

      const updatedRow = updated.rows[0];
      if (!updatedRow) {
        await client.query("ROLLBACK");
        return { kind: "CONCURRENT_CONFLICT" };
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
          return { kind: "CONCURRENT_CONFLICT" };
        }
      }

      const eventResult = await client.query<EventRow>(
        `
          INSERT INTO app.user_position_event (
            event_id,
            position_id,
            participation_id,
            user_id,
            signal_id,
            event_type,
            event_identity,
            global_event_identity,
            global_sequence,
            occurred_at,
            observed_at,
            payload,
            created_at
          )
          VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8,
            $9::bigint, $10::timestamptz, $11::timestamptz,
            $12::jsonb, clock_timestamp()
          )
          RETURNING ${EVENT_COLUMNS}
        `,
        [
          input.event.eventId,
          p.positionId,
          p.participationId,
          p.userId,
          p.signalId,
          input.event.eventType,
          input.event.eventIdentity,
          input.event.globalEventIdentity,
          input.event.globalSequence,
          input.event.occurredAt,
          input.event.observedAt,
          JSON.stringify(input.event.payload),
        ],
      );

      const eventRow = eventResult.rows[0];
      if (!eventRow) {
        throw new Error("event insert returned no row");
      }

      let outcome: UserPositionOutcomeRecord | null = null;

      if (input.terminalOutcome) {
        const built = buildTerminalOutcome(p, input.terminalOutcome);

        const outcomeResult = await client.query<OutcomeRow>(
          `
            INSERT INTO app.user_position_outcome (
              position_id,
              participation_id,
              user_id,
              signal_id,
              terminal_reason,
              user_terminal_state,
              global_terminal_status,
              actual_exit_price,
              realized_pnl,
              realized_return,
              realized_fraction,
              fees,
              theoretical_global_pnl,
              opportunity_delta,
              completed_at,
              global_completed_at,
              created_at
            )
            VALUES (
              $1, $2, $3, $4, $5, $6,
              NULL, $7, $8, $9, $10, $11,
              NULL, NULL, $12::timestamptz, NULL,
              clock_timestamp()
            )
            RETURNING ${OUTCOME_COLUMNS}
          `,
          [
            built.positionId,
            built.participationId,
            built.userId,
            built.signalId,
            built.terminalReason,
            built.userTerminalState,
            built.actualExitPrice,
            built.realizedPnl,
            built.realizedReturn,
            built.realizedFraction,
            built.fees,
            built.completedAt,
          ],
        );

        if (!outcomeResult.rows[0]) {
          throw new Error("outcome insert returned no row");
        }

        outcome = mapOutcome(outcomeResult.rows[0]);
      }

      await client.query("COMMIT");

      return {
        kind: "APPLIED",
        position: mapPosition(updatedRow),
        event: mapEvent(eventRow),
        outcome,
      };
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {}
      throw error;
    } finally {
      client.release();
    }
  }

  async appendObservation(input: {
    userId: string;
    positionId: string;
    event: LedgerEventDraft;
  }): Promise<LedgerCommitResult> {
    const client = await this.#db.connect();

    try {
      await client.query("BEGIN");

      const locked = await client.query<PositionRow>(
        `
          SELECT ${POSITION_COLUMNS}
          FROM app.user_position
          WHERE user_id = $1
            AND position_id = $2
          FOR UPDATE
        `,
        [input.userId, input.positionId],
      );

      const row = locked.rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        return { kind: "NOT_FOUND" };
      }

      const position = mapPosition(row);

      const duplicate = await selectEvent(
        client,
        input.userId,
        input.positionId,
        input.event.eventIdentity,
      );

      if (duplicate) {
        const outcome = await selectOutcome(
          client,
          input.userId,
          input.positionId,
        );
        await client.query("COMMIT");
        return {
          kind: "IDEMPOTENT_REPLAY",
          position,
          event: duplicate,
          outcome,
        };
      }

      const inserted = await client.query<EventRow>(
        `
          INSERT INTO app.user_position_event (
            event_id,
            position_id,
            participation_id,
            user_id,
            signal_id,
            event_type,
            event_identity,
            global_event_identity,
            global_sequence,
            occurred_at,
            observed_at,
            payload,
            created_at
          )
          VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8,
            $9::bigint, $10::timestamptz, $11::timestamptz,
            $12::jsonb, clock_timestamp()
          )
          RETURNING ${EVENT_COLUMNS}
        `,
        [
          input.event.eventId,
          position.positionId,
          position.participationId,
          position.userId,
          position.signalId,
          input.event.eventType,
          input.event.eventIdentity,
          input.event.globalEventIdentity,
          input.event.globalSequence,
          input.event.occurredAt,
          input.event.observedAt,
          JSON.stringify(input.event.payload),
        ],
      );

      const eventRow = inserted.rows[0];
      if (!eventRow) {
        throw new Error("observation insert returned no row");
      }

      const outcome = await selectOutcome(
        client,
        input.userId,
        input.positionId,
      );

      await client.query("COMMIT");

      return {
        kind: "APPLIED",
        position,
        event: mapEvent(eventRow),
        outcome,
      };
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
