import type {
  CreateParticipationInput,
  ParticipationRepository,
} from "./repository.js";
import type {
  UserSignalParticipation,
  UserSignalParticipationStatus,
} from "./types.js";

interface QueryResultLike<Row> {
  rows: Row[];
  rowCount?: number | null;
}

export interface ParticipationSqlExecutor {
  query<Row = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResultLike<Row>>;
}

interface ParticipationRow {
  participation_id: string;
  user_id: string;
  signal_id: string;
  status: UserSignalParticipationStatus;
  subscribed_at: string | Date;
  unsubscribed_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
}

function timestamp(value: string | Date): string {
  return typeof value === "string" ? new Date(value).toISOString() : value.toISOString();
}

function nullableTimestamp(value: string | Date | null): string | null {
  return value === null ? null : timestamp(value);
}

function mapRow(row: ParticipationRow): UserSignalParticipation {
  return {
    participationId: row.participation_id,
    userId: row.user_id,
    signalId: row.signal_id,
    status: row.status,
    subscribedAt: timestamp(row.subscribed_at),
    unsubscribedAt: nullableTimestamp(row.unsubscribed_at),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  };
}

const RETURN_COLUMNS = `
  participation_id,
  user_id,
  signal_id,
  status,
  subscribed_at,
  unsubscribed_at,
  created_at,
  updated_at
`;

export class PostgresParticipationRepository implements ParticipationRepository {
  readonly #db: ParticipationSqlExecutor;

  constructor(db: ParticipationSqlExecutor) {
    this.#db = db;
  }

  async signalExists(signalId: string): Promise<boolean> {
    const result = await this.#db.query<{ exists: boolean }>(
      `
        SELECT EXISTS (
          SELECT 1
          FROM projection.published_signals
          WHERE signal_id = $1
        ) AS exists
      `,
      [signalId],
    );

    return result.rows[0]?.exists === true;
  }

  async findLiveByUserSignal(
    userId: string,
    signalId: string,
  ): Promise<UserSignalParticipation | null> {
    const result = await this.#db.query<ParticipationRow>(
      `
        SELECT ${RETURN_COLUMNS}
        FROM app.user_signal_participation
        WHERE user_id = $1
          AND signal_id = $2
          AND status IN ('FOLLOWING', 'PLANNED', 'ACTIVE')
        ORDER BY created_at DESC, participation_id DESC
        LIMIT 1
      `,
      [userId, signalId],
    );

    const row = result.rows[0];
    return row ? mapRow(row) : null;
  }

  async findOwnedById(
    userId: string,
    participationId: string,
  ): Promise<UserSignalParticipation | null> {
    const result = await this.#db.query<ParticipationRow>(
      `
        SELECT ${RETURN_COLUMNS}
        FROM app.user_signal_participation
        WHERE user_id = $1
          AND participation_id = $2
        LIMIT 1
      `,
      [userId, participationId],
    );

    const row = result.rows[0];
    return row ? mapRow(row) : null;
  }

  async tryCreateFollowing(
    input: CreateParticipationInput,
  ): Promise<UserSignalParticipation | null> {
    const result = await this.#db.query<ParticipationRow>(
      `
        INSERT INTO app.user_signal_participation (
          participation_id,
          user_id,
          signal_id,
          status,
          subscribed_at,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, 'FOLLOWING', $4::timestamptz, $4::timestamptz, $4::timestamptz)
        ON CONFLICT DO NOTHING
        RETURNING ${RETURN_COLUMNS}
      `,
      [
        input.participationId,
        input.userId,
        input.signalId,
        input.subscribedAt,
      ],
    );

    const row = result.rows[0];
    return row ? mapRow(row) : null;
  }

  async transitionOwned(
    userId: string,
    participationId: string,
    expectedStatuses: readonly UserSignalParticipationStatus[],
    nextStatus: UserSignalParticipationStatus,
    observedAt: string,
    unsubscribedAt: string | null,
  ): Promise<UserSignalParticipation | null> {
    const result = await this.#db.query<ParticipationRow>(
      `
        UPDATE app.user_signal_participation
        SET
          status = $3,
          updated_at = $4::timestamptz,
          unsubscribed_at = $5::timestamptz
        WHERE user_id = $1
          AND participation_id = $2
          AND status = ANY($6::text[])
        RETURNING ${RETURN_COLUMNS}
      `,
      [
        userId,
        participationId,
        nextStatus,
        observedAt,
        unsubscribedAt,
        [...expectedStatuses],
      ],
    );

    const row = result.rows[0];
    return row ? mapRow(row) : null;
  }
}
