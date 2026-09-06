import type {
  Pool,
} from "pg";

type SessionControlDatabase =
  Pick<Pool, "query">;

type SessionCredentialRow = {
  token: string;
};

export type OwnedSessionCredential =
  Readonly<{
    token: string;
  }>;

function assertIdentifier(
  value: string,
  label: string,
): void {
  if (
    value.length === 0 ||
    value !== value.trim()
  ) {
    throw new Error(
      `${label} must be a non-empty canonical identifier.`,
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
      "Session control timestamp must be valid.",
    );
  }
}

/*
 * This mutation-only path is the one place in A3
 * where a target session token must be loaded.
 *
 * The token never leaves backend memory and is
 * passed directly to Better Auth revokeSession().
 */
export async function getOwnedActiveSessionCredential(
  database:
    SessionControlDatabase,
  userId: string,
  sessionId: string,
  observedAt: Date,
): Promise<
  OwnedSessionCredential | null
> {
  assertIdentifier(
    userId,
    "User ID",
  );

  assertIdentifier(
    sessionId,
    "Session ID",
  );

  assertObservedAt(
    observedAt,
  );

  const result =
    await database.query<SessionCredentialRow>(
      `
        SELECT
          s."token" AS token
        FROM auth."session" AS s
        WHERE
          s."id" = $1
          AND s."userId" = $2
          AND s."expiresAt" > $3
        LIMIT 1
      `,
      [
        sessionId,
        userId,
        observedAt,
      ],
    );

  const row =
    result.rows[0];

  if (row === undefined) {
    return null;
  }

  return Object.freeze({
    token:
      row.token,
  });
}
