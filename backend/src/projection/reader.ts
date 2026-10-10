import type { Pool } from "pg";

export type ProjectionReadDatabase =
  Pick<Pool, "query">;

export type JsonObject =
  Record<string, unknown>;

export interface SignalReadModel {
  readonly signalId: string;
  readonly projection: JsonObject;
  readonly current: JsonObject | null;
  readonly outcome: JsonObject | null;
}

export interface SignalEventsReadModel {
  readonly signalId: string;
  readonly events: readonly JsonObject[];
}

export interface SignalOutcomeReadModel {
  readonly signalId: string;
  readonly outcome: JsonObject | null;
}

export interface ProjectionReader {
  listSignals(limit: number): Promise<readonly SignalReadModel[]>;
  getSignal(signalId: string): Promise<SignalReadModel | null>;
  getEvents(signalId: string): Promise<SignalEventsReadModel | null>;
  getOutcome(signalId: string): Promise<SignalOutcomeReadModel | null>;
}

function requireSignalId(signalId: string): string {
  if (
    signalId.length < 1 ||
    signalId.length > 128 ||
    /[\u0000-\u001f\u007f]/u.test(signalId)
  ) {
    throw new TypeError("signalId is invalid");
  }

  return signalId;
}

function requireListLimit(limit: number): number {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100
  ) {
    throw new TypeError(
      "signal list limit must be an integer between 1 and 100",
    );
  }

  return limit;
}

function requireObject(
  value: unknown,
  label: string,
): JsonObject {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new TypeError(`${label} must be a JSON object`);
  }

  return value as JsonObject;
}

function optionalObject(
  value: unknown,
  label: string,
): JsonObject | null {
  if (value === null || value === undefined) {
    return null;
  }

  return requireObject(value, label);
}

function requireRowSignalId(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 128
  ) {
    throw new TypeError(
      "projection row contains invalid signal_id",
    );
  }

  return value;
}

function projectSignalRow(
  row: Record<string, unknown>,
): SignalReadModel {
  return Object.freeze({
    signalId:
      requireRowSignalId(
        row.signal_id,
      ),
    projection:
      requireObject(
        row.projection_payload,
        "projection_payload",
      ),
    current:
      optionalObject(
        row.snapshot_payload,
        "snapshot_payload",
      ),
    outcome:
      optionalObject(
        row.outcome_payload,
        "outcome_payload",
      ),
  });
}

export class PostgresProjectionReader
implements ProjectionReader {
  constructor(
    private readonly database:
      ProjectionReadDatabase,
  ) {}

  async listSignals(
    limitInput: number,
  ): Promise<readonly SignalReadModel[]> {
    const limit =
      requireListLimit(limitInput);

    const result =
      await this.database.query(
        `
          SELECT
            p.signal_id,
            p.projection_payload,
            c.snapshot_payload,
            o.outcome_payload
          FROM projection.published_signals p
          LEFT JOIN projection.signal_current c
            ON c.signal_id = p.signal_id
          LEFT JOIN projection.signal_outcomes o
            ON o.signal_id = p.signal_id
          ORDER BY
            p.published_at DESC,
            p.signal_id ASC
          LIMIT $1
        `,
        [limit],
      );

    return Object.freeze(
      result.rows.map((row) =>
        projectSignalRow(
          row as Record<string, unknown>,
        ),
      ),
    );
  }

  async getSignal(
    signalIdInput: string,
  ): Promise<SignalReadModel | null> {
    const signalId =
      requireSignalId(signalIdInput);

    const result =
      await this.database.query(
        `
          SELECT
            p.signal_id,
            p.projection_payload,
            c.snapshot_payload,
            o.outcome_payload
          FROM projection.published_signals p
          LEFT JOIN projection.signal_current c
            ON c.signal_id = p.signal_id
          LEFT JOIN projection.signal_outcomes o
            ON o.signal_id = p.signal_id
          WHERE p.signal_id = $1
        `,
        [signalId],
      );

    if (result.rows.length === 0) {
      return null;
    }

    if (result.rows.length !== 1) {
      throw new Error(
        "projection signal identity is not unique",
      );
    }

    return projectSignalRow(
      result.rows[0] as
        Record<string, unknown>,
    );
  }

  async getEvents(
    signalIdInput: string,
  ): Promise<SignalEventsReadModel | null> {
    const signalId =
      requireSignalId(signalIdInput);

    const result =
      await this.database.query(
        `
          SELECT
            p.signal_id,
            e.event_payload
          FROM projection.published_signals p
          LEFT JOIN projection.signal_events e
            ON e.signal_id = p.signal_id
          WHERE p.signal_id = $1
          ORDER BY e.sequence ASC
        `,
        [signalId],
      );

    if (result.rows.length === 0) {
      return null;
    }

    const first =
      result.rows[0] as
        Record<string, unknown>;

    const authoritativeSignalId =
      requireRowSignalId(
        first.signal_id,
      );

    const events: JsonObject[] = [];

    for (const rawRow of result.rows) {
      const row =
        rawRow as
          Record<string, unknown>;

      if (
        requireRowSignalId(
          row.signal_id,
        ) !== authoritativeSignalId
      ) {
        throw new Error(
          "projection event query crossed signal identity",
        );
      }

      if (
        row.event_payload !== null &&
        row.event_payload !== undefined
      ) {
        events.push(
          requireObject(
            row.event_payload,
            "event_payload",
          ),
        );
      }
    }

    return Object.freeze({
      signalId:
        authoritativeSignalId,
      events:
        Object.freeze(events),
    });
  }

  async getOutcome(
    signalIdInput: string,
  ): Promise<SignalOutcomeReadModel | null> {
    const signalId =
      requireSignalId(signalIdInput);

    const result =
      await this.database.query(
        `
          SELECT
            p.signal_id,
            o.outcome_payload
          FROM projection.published_signals p
          LEFT JOIN projection.signal_outcomes o
            ON o.signal_id = p.signal_id
          WHERE p.signal_id = $1
        `,
        [signalId],
      );

    if (result.rows.length === 0) {
      return null;
    }

    if (result.rows.length !== 1) {
      throw new Error(
        "projection outcome identity is not unique",
      );
    }

    const row =
      result.rows[0] as
        Record<string, unknown>;

    return Object.freeze({
      signalId:
        requireRowSignalId(
          row.signal_id,
        ),
      outcome:
        optionalObject(
          row.outcome_payload,
          "outcome_payload",
        ),
    });
  }
}
