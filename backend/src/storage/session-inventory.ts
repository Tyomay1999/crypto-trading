import type {
  Pool,
} from "pg";

type SessionInventoryDatabase =
  Pick<Pool, "query">;

type SessionInventoryRow = {
  session_id: string;
  created_at: Date;
  expires_at: Date;
  ip_address: string | null;
  user_agent: string | null;
  last_activity_at: Date;
};

/*
 * Internal-only record.
 *
 * It deliberately has no token property.
 * Session-management listing must never load
 * Better Auth bearer credentials from PostgreSQL.
 */
export type ActiveSessionRecord =
  Readonly<{
    sessionId: string;
    createdAt: Date;
    expiresAt: Date;
    ipAddress: string | null;
    userAgent: string | null;
    lastActivityAt: Date;
  }>;

function assertUserId(
  userId: string,
): void {
  if (userId.trim().length === 0) {
    throw new Error(
      "User ID must not be empty.",
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
      "Session inventory timestamp must be valid.",
    );
  }
}

export async function listActiveSessions(
  database: SessionInventoryDatabase,
  userId: string,
  observedAt: Date,
): Promise<ActiveSessionRecord[]> {
  assertUserId(userId);
  assertObservedAt(observedAt);

  /*
   * SECURITY:
   * Do not add s."token" to this SELECT.
   *
   * The session-management read path needs
   * metadata only, never the bearer credential.
   */
  const result =
    await database.query<SessionInventoryRow>(
      `
        SELECT
          s."id" AS session_id,
          s."createdAt" AS created_at,
          s."expiresAt" AS expires_at,
          s."ipAddress" AS ip_address,
          s."userAgent" AS user_agent,
          COALESCE(
            activity.last_activity_at,
            s."createdAt"
          ) AS last_activity_at
        FROM auth."session" AS s
        LEFT JOIN app.auth_session_activity
          AS activity
          ON activity.session_id = s."id"
        WHERE
          s."userId" = $1
          AND s."expiresAt" > $2
        ORDER BY
          s."createdAt" DESC,
          s."id" ASC
      `,
      [
        userId,
        observedAt,
      ],
    );

  return result.rows.map(
    (row) => ({
      sessionId:
        row.session_id,
      createdAt:
        row.created_at,
      expiresAt:
        row.expires_at,
      ipAddress:
        row.ip_address,
      userAgent:
        row.user_agent,
      lastActivityAt:
        row.last_activity_at,
    }),
  );
}
