import type { ProjectionWriter } from "./writer.js";

const FROZEN_SCHEMA_SHA256 =
  "dbdd0af64715596f705f3dff74f368fd1815dc26e22f326ddba10b400fa9dfa1";

type PublishSignalArgs = Parameters<ProjectionWriter["publishSignal"]>;
type AppendLifecycleEventArgs =
  Parameters<ProjectionWriter["appendLifecycleEvent"]>;
type UpdateSnapshotArgs = Parameters<ProjectionWriter["updateSnapshot"]>;
type WriteOutcomeArgs = Parameters<ProjectionWriter["writeOutcome"]>;

export interface ProjectionSqlResult {
  readonly rowCount: number | null;
}

export interface ProjectionSqlClient {
  query(text: string, values?: unknown[]): Promise<ProjectionSqlResult>;
}

export class ProjectionPersistenceConflictError extends Error {
  readonly code = "PROJECTION_PERSISTENCE_CONFLICT";

  constructor(readonly reason: string) {
    super(`Projection persistence conflict: ${reason}`);
    this.name = "ProjectionPersistenceConflictError";
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new TypeError(`${label} must be a JSON object`);
  }

  return value as Record<string, unknown>;
}

function requireString(
  record: Record<string, unknown>,
  key: string,
  label: string,
): string {
  const value = record[key];

  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label}.${key} must be a non-empty string`);
  }

  return value;
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
): string | null {
  const value = record[key];

  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${key} must be null or a non-empty string`);
  }

  return value;
}

function requirePositiveSafeInteger(
  record: Record<string, unknown>,
  key: string,
  label: string,
): number {
  const value = record[key];

  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1
  ) {
    throw new TypeError(
      `${label}.${key} must be a positive safe integer`,
    );
  }

  return value;
}

function verifyPayloadSignalId(
  signalId: string,
  payload: Record<string, unknown>,
  label: string,
): void {
  const payloadSignalId = requireString(
    payload,
    "signalId",
    label,
  );

  if (payloadSignalId !== signalId) {
    throw new ProjectionPersistenceConflictError(
      "signal_id_payload_signal_id_mismatch",
    );
  }
}

function requireSignalId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("signalId must be a non-empty string");
  }

  return value;
}

export class PostgresProjectionWriter implements ProjectionWriter {
  constructor(private readonly sql: ProjectionSqlClient) {}

  async publishSignal(
    signalIdInput: PublishSignalArgs[0],
    payloadInput: PublishSignalArgs[1],
  ): Promise<void> {
    const signalId = requireSignalId(signalIdInput);
    const payload = requireRecord(payloadInput, "SignalProjection");

    verifyPayloadSignalId(
      signalId,
      payload,
      "SignalProjection",
    );

    const result = await this.sql.query(
      `
        INSERT INTO projection.published_signals (
          signal_id,
          contract_schema_sha256,
          exchange,
          market,
          symbol,
          direction,
          published_at,
          expires_at,
          projection_payload
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
        RETURNING signal_id
      `,
      [
        signalId,
        FROZEN_SCHEMA_SHA256,
        requireString(payload, "exchange", "SignalProjection"),
        requireString(payload, "market", "SignalProjection"),
        requireString(payload, "symbol", "SignalProjection"),
        requireString(payload, "direction", "SignalProjection"),
        requireString(payload, "publishedAt", "SignalProjection"),
        requireString(payload, "expiresAt", "SignalProjection"),
        JSON.stringify(payload),
      ],
    );

    if (result.rowCount !== 1) {
      throw new ProjectionPersistenceConflictError(
        "publish_not_persisted",
      );
    }
  }

  async appendLifecycleEvent(
    signalIdInput: AppendLifecycleEventArgs[0],
    payloadInput: AppendLifecycleEventArgs[1],
  ): Promise<void> {
    const signalId = requireSignalId(signalIdInput);
    const payload = requireRecord(
      payloadInput,
      "SignalLifecycleEvent",
    );

    verifyPayloadSignalId(
      signalId,
      payload,
      "SignalLifecycleEvent",
    );

    const result = await this.sql.query(
      `
        INSERT INTO projection.signal_events (
          signal_id,
          sequence,
          event_type,
          from_state,
          to_state,
          occurred_at,
          event_payload
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
        RETURNING signal_id
      `,
      [
        signalId,
        requirePositiveSafeInteger(
          payload,
          "sequence",
          "SignalLifecycleEvent",
        ),
        requireString(
          payload,
          "eventType",
          "SignalLifecycleEvent",
        ),
        optionalString(payload, "fromState"),
        requireString(
          payload,
          "toState",
          "SignalLifecycleEvent",
        ),
        requireString(
          payload,
          "occurredAt",
          "SignalLifecycleEvent",
        ),
        JSON.stringify(payload),
      ],
    );

    if (result.rowCount !== 1) {
      throw new ProjectionPersistenceConflictError(
        "event_not_persisted",
      );
    }
  }

  async updateSnapshot(
    signalIdInput: UpdateSnapshotArgs[0],
    payloadInput: UpdateSnapshotArgs[1],
  ): Promise<void> {
    const signalId = requireSignalId(signalIdInput);
    const payload = requireRecord(payloadInput, "SignalSnapshot");

    verifyPayloadSignalId(
      signalId,
      payload,
      "SignalSnapshot",
    );

    const lifecycleState = requireString(
      payload,
      "lifecycleState",
      "SignalSnapshot",
    );

    const updatedAt = requireString(
      payload,
      "updatedAt",
      "SignalSnapshot",
    );

    const result = await this.sql.query(
      `
        WITH event_frontier AS (
          SELECT
            sequence,
            to_state,
            occurred_at
          FROM projection.signal_events
          WHERE signal_id = $1
          ORDER BY sequence DESC
          LIMIT 1
        )
        INSERT INTO projection.signal_current (
          signal_id,
          lifecycle_state,
          sequence,
          as_of,
          terminal_at,
          snapshot_payload
        )
        SELECT
          $1,
          $2,
          event_frontier.sequence,
          $3,
          $4,
          $5::jsonb
        FROM event_frontier
        WHERE
          event_frontier.to_state = $2
          AND event_frontier.occurred_at <= $3::timestamptz
        ON CONFLICT (signal_id)
        DO UPDATE SET
          lifecycle_state = EXCLUDED.lifecycle_state,
          sequence = EXCLUDED.sequence,
          as_of = EXCLUDED.as_of,
          terminal_at = EXCLUDED.terminal_at,
          snapshot_payload = EXCLUDED.snapshot_payload,
          persisted_at = CURRENT_TIMESTAMP
        WHERE
          EXCLUDED.sequence > projection.signal_current.sequence
          OR (
            EXCLUDED.sequence = projection.signal_current.sequence
            AND EXCLUDED.lifecycle_state =
              projection.signal_current.lifecycle_state
            AND EXCLUDED.as_of = projection.signal_current.as_of
            AND EXCLUDED.terminal_at IS NOT DISTINCT FROM
              projection.signal_current.terminal_at
            AND EXCLUDED.snapshot_payload =
              projection.signal_current.snapshot_payload
          )
        RETURNING signal_id
      `,
      [
        signalId,
        lifecycleState,
        updatedAt,
        optionalString(payload, "terminalAt"),
        JSON.stringify(payload),
      ],
    );

    if (result.rowCount !== 1) {
      throw new ProjectionPersistenceConflictError(
        "snapshot_event_frontier_or_payload_conflict",
      );
    }
  }

  async writeOutcome(
    signalIdInput: WriteOutcomeArgs[0],
    payloadInput: WriteOutcomeArgs[1],
  ): Promise<void> {
    const signalId = requireSignalId(signalIdInput);
    const payload = requireRecord(payloadInput, "SignalOutcome");

    verifyPayloadSignalId(
      signalId,
      payload,
      "SignalOutcome",
    );

    const result = await this.sql.query(
      `
        INSERT INTO projection.signal_outcomes (
          signal_id,
          final_status,
          as_of,
          outcome_payload
        )
        VALUES ($1, $2, $3, $4::jsonb)
        RETURNING signal_id
      `,
      [
        signalId,
        requireString(payload, "finalStatus", "SignalOutcome"),
        requireString(payload, "asOf", "SignalOutcome"),
        JSON.stringify(payload),
      ],
    );

    if (result.rowCount !== 1) {
      throw new ProjectionPersistenceConflictError(
        "outcome_not_persisted",
      );
    }
  }

}

export function asProjectionWriter(
  writer: PostgresProjectionWriter,
): ProjectionWriter {
  return writer;
}
