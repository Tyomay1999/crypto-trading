import type {
  Pool,
} from "pg";

type SessionActivityDatabase =
  Pick<Pool, "query">;

type SessionActivityRow = {
  session_id: string;
  last_activity_at: Date;
};

export type SessionActivityTouchResult = {
  updated: boolean;
  lastActivityAt: Date | null;
};

function assertSessionId(
  sessionId: string,
): void {
  if (sessionId.trim().length === 0) {
    throw new Error(
      "Session ID must not be empty.",
    );
  }
}

function assertObservedAt(
  observedAt: Date,
): void {
  if (
    Number.isNaN(
      observedAt.getTime(),
    )
  ) {
    throw new Error(
      "Session activity timestamp must be valid.",
    );
  }
}

/*
 * Authenticated request activity is intentionally
 * persisted at most once per five minutes.
 *
 * The WHERE clause also gives monotonic semantics:
 * an older observation can never move
 * last_activity_at backwards.
 */
export async function touchSessionActivity(
  database: SessionActivityDatabase,
  sessionId: string,
  observedAt: Date,
): Promise<SessionActivityTouchResult> {
  assertSessionId(sessionId);
  assertObservedAt(observedAt);

  const result =
    await database.query<SessionActivityRow>(
      `
        INSERT INTO app.auth_session_activity (
          session_id,
          last_activity_at
        )
        VALUES ($1, $2)
        ON CONFLICT (session_id)
        DO UPDATE
        SET
          last_activity_at =
            EXCLUDED.last_activity_at
        WHERE
          app.auth_session_activity.last_activity_at
            <= EXCLUDED.last_activity_at
              - INTERVAL '5 minutes'
        RETURNING
          session_id,
          last_activity_at
      `,
      [
        sessionId,
        observedAt,
      ],
    );

  const row = result.rows[0];

  return {
    updated: result.rowCount === 1,
    lastActivityAt:
      row?.last_activity_at ?? null,
  };
}

export async function getSessionActivities(
  database: SessionActivityDatabase,
  sessionIds: readonly string[],
): Promise<Map<string, Date>> {
  if (sessionIds.length === 0) {
    return new Map();
  }

  for (const sessionId of sessionIds) {
    assertSessionId(sessionId);
  }

  const result =
    await database.query<SessionActivityRow>(
      `
        SELECT
          session_id,
          last_activity_at
        FROM app.auth_session_activity
        WHERE session_id = ANY($1::text[])
      `,
      [
        [...sessionIds],
      ],
    );

  return new Map(
    result.rows.map(
      (row) => [
        row.session_id,
        row.last_activity_at,
      ],
    ),
  );
}
