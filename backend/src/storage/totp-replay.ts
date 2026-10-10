import type {
  Pool,
} from "pg";

type TotpDatabase =
  Pick<
    Pool,
    "connect" | "query"
  >;

export type TotpEnrollmentState =
  | "absent"
  | "pending"
  | "active"
  | "inconsistent";

export async function getTotpEnrollmentState(
  database: TotpDatabase,
  userId: string,
): Promise<TotpEnrollmentState> {
  if (
    userId.length === 0 ||
    userId !== userId.trim()
  ) {
    throw new Error(
      "Invalid TOTP enrollment identity.",
    );
  }

  const result =
    await database.query(
      `
        SELECT
          u."twoFactorEnabled"
            AS "twoFactorEnabled",
          tf."verified"
            AS "verified"
        FROM auth."user" AS u
        LEFT JOIN auth."twoFactor" AS tf
          ON tf."userId" = u."id"
        WHERE u."id" = $1
        LIMIT 1
      `,
      [
        userId,
      ],
    );

  if (result.rowCount !== 1) {
    return "inconsistent";
  }

  const row =
    result.rows[0] as {
      twoFactorEnabled?: unknown;
      verified?: unknown;
    };

  if (
    row.twoFactorEnabled === true &&
    row.verified === true
  ) {
    return "active";
  }

  if (
    row.twoFactorEnabled === false &&
    row.verified === false
  ) {
    return "pending";
  }

  if (
    row.twoFactorEnabled === false &&
    (
      row.verified === null ||
      row.verified === undefined
    )
  ) {
    return "absent";
  }

  return "inconsistent";
}

async function lockNewSession(
  client: {
    query: (
      sql: string,
      values?: readonly unknown[],
    ) => Promise<{
      rowCount: number | null;
      rows: unknown[];
    }>;
  },
  sessionToken: string,
  userId: string,
  observedAt: Date,
): Promise<void> {
  const session =
    await client.query(
      `
        SELECT
          "userId"
        FROM auth."session"
        WHERE "token" = $1
          AND "userId" = $2
          AND "expiresAt" > $3
        FOR UPDATE
      `,
      [
        sessionToken,
        userId,
        observedAt,
      ],
    );

  if (session.rowCount !== 1) {
    throw new Error(
      "TOTP verification session is unavailable.",
    );
  }
}

async function lockRotatedEnrollmentSession(
  client: {
    query: (
      sql: string,
      values?: readonly unknown[],
    ) => Promise<{
      rowCount: number | null;
      rows: unknown[];
    }>;
  },
  sessionId: string,
  userId: string,
  observedAt: Date,
): Promise<void> {
  const session =
    await client.query(
      `
        SELECT
          "userId"
        FROM auth."session"
        WHERE "id" = $1
          AND "userId" = $2
          AND "expiresAt" > $3
        FOR UPDATE
      `,
      [
        sessionId,
        userId,
        observedAt,
      ],
    );

  if (session.rowCount !== 1) {
    throw new Error(
      "TOTP enrollment verification session is unavailable.",
    );
  }
}

async function claimReplayDigest(
  client: {
    query: (
      sql: string,
      values?: readonly unknown[],
    ) => Promise<{
      rowCount: number | null;
      rows: unknown[];
    }>;
  },
  userId: string,
  codeDigest: string,
  acceptedAt: Date,
  expiresAt: Date,
): Promise<boolean> {
  await client.query(
    `
      DELETE FROM app.auth_totp_replay_guard
      WHERE user_id = $1
        AND expires_at <= $2
    `,
    [
      userId,
      acceptedAt,
    ],
  );

  const claimed =
    await client.query(
      `
        INSERT INTO app.auth_totp_replay_guard (
          user_id,
          code_digest,
          accepted_at,
          expires_at
        )
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (
          user_id,
          code_digest
        )
        DO NOTHING
        RETURNING user_id
      `,
      [
        userId,
        codeDigest,
        acceptedAt,
        expiresAt,
      ],
    );

  return claimed.rowCount === 1;
}

function validateFinalization(
  sessionToken: string,
  userId: string,
  codeDigest: string,
  acceptedAt: Date,
  expiresAt: Date,
): void {
  if (
    sessionToken.length === 0 ||
    userId.length === 0 ||
    !/^[a-f0-9]{64}$/.test(
      codeDigest,
    ) ||
    !Number.isFinite(
      acceptedAt.getTime(),
    ) ||
    !Number.isFinite(
      expiresAt.getTime(),
    ) ||
    expiresAt.getTime() <=
      acceptedAt.getTime()
  ) {
    throw new Error(
      "Invalid TOTP verification finalization.",
    );
  }
}

export async function finalizeTotpLoginChallenge(
  database: TotpDatabase,
  sessionToken: string,
  userId: string,
  codeDigest: string,
  acceptedAt: Date,
  expiresAt: Date,
): Promise<boolean> {
  validateFinalization(
    sessionToken,
    userId,
    codeDigest,
    acceptedAt,
    expiresAt,
  );

  const client =
    await database.connect();

  let transactionStarted =
    false;

  try {
    await client.query(
      "BEGIN",
    );

    transactionStarted =
      true;

    await lockNewSession(
      client,
      sessionToken,
      userId,
      acceptedAt,
    );

    const claimed =
      await claimReplayDigest(
        client,
        userId,
        codeDigest,
        acceptedAt,
        expiresAt,
      );

    if (!claimed) {
      const deleted =
        await client.query(
          `
            DELETE FROM auth."session"
            WHERE "token" = $1
              AND "userId" = $2
          `,
          [
            sessionToken,
            userId,
          ],
        );

      if (deleted.rowCount !== 1) {
        throw new Error(
          "Replayed TOTP login session cleanup failed.",
        );
      }

      await client.query(
        "COMMIT",
      );

      transactionStarted =
        false;

      return false;
    }

    await client.query(
      "COMMIT",
    );

    transactionStarted =
      false;

    return true;
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query(
          "ROLLBACK",
        );
      } catch {
        // Caller remains fail-closed.
      }
    }

    throw error;
  } finally {
    client.release();
  }
}

export async function finalizeTotpEnrollmentVerification(
  database: TotpDatabase,
  sessionId: string,
  userId: string,
  codeDigest: string,
  acceptedAt: Date,
  expiresAt: Date,
): Promise<boolean> {
  validateFinalization(
    sessionId,
    userId,
    codeDigest,
    acceptedAt,
    expiresAt,
  );

  const client =
    await database.connect();

  let transactionStarted =
    false;

  try {
    await client.query(
      "BEGIN",
    );

    transactionStarted =
      true;

    await lockRotatedEnrollmentSession(
      client,
      sessionId,
      userId,
      acceptedAt,
    );

    const claimed =
      await claimReplayDigest(
        client,
        userId,
        codeDigest,
        acceptedAt,
        expiresAt,
      );

    if (!claimed) {
      const deleted =
        await client.query(
          `
            DELETE FROM auth."session"
            WHERE "id" = $1
              AND "userId" = $2
          `,
          [
            sessionId,
            userId,
          ],
        );

      if (deleted.rowCount !== 1) {
        throw new Error(
          "Replayed TOTP enrollment session cleanup failed.",
        );
      }

      await client.query(
        "COMMIT",
      );

      transactionStarted =
        false;

      return false;
    }

    /*
     * Enabling MFA changes the account's security
     * posture. Sessions created before activation
     * are not allowed to survive.
     */
    await client.query(
      `
        DELETE FROM auth."session"
        WHERE "userId" = $1
          AND "id" <> $2
      `,
      [
        userId,
        sessionId,
      ],
    );

    await client.query(
      "COMMIT",
    );

    transactionStarted =
      false;

    return true;
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query(
          "ROLLBACK",
        );
      } catch {
        // Caller remains fail-closed.
      }
    }

    throw error;
  } finally {
    client.release();
  }
}

export async function disableTotpAndRevokeAllSessions(
  database: TotpDatabase,
  userId: string,
  disabledAt: Date,
): Promise<boolean> {
  if (
    userId.length === 0 ||
    !Number.isFinite(
      disabledAt.getTime(),
    )
  ) {
    throw new Error(
      "Invalid TOTP disable request.",
    );
  }

  const client =
    await database.connect();

  let transactionStarted =
    false;

  try {
    await client.query(
      "BEGIN",
    );

    transactionStarted =
      true;

    const user =
      await client.query(
        `
          SELECT
            "twoFactorEnabled"
          FROM auth."user"
          WHERE "id" = $1
          FOR UPDATE
        `,
        [
          userId,
        ],
      );

    if (user.rowCount !== 1) {
      throw new Error(
        "TOTP disable user is unavailable.",
      );
    }

    const factor =
      await client.query(
        `
          SELECT
            "verified"
          FROM auth."twoFactor"
          WHERE "userId" = $1
          FOR UPDATE
        `,
        [
          userId,
        ],
      );

    const userRow =
      user.rows[0] as {
        twoFactorEnabled?: unknown;
      };

    const factorRow =
      factor.rows[0] as
        | {
            verified?: unknown;
          }
        | undefined;

    if (
      userRow.twoFactorEnabled !== true ||
      factor.rowCount !== 1 ||
      factorRow?.verified !== true
    ) {
      await client.query(
        "ROLLBACK",
      );

      transactionStarted =
        false;

      return false;
    }

    await client.query(
      `
        UPDATE auth."user"
        SET
          "twoFactorEnabled" = FALSE,
          "updatedAt" = $2
        WHERE "id" = $1
      `,
      [
        userId,
        disabledAt,
      ],
    );

    const factorDelete =
      await client.query(
        `
          DELETE FROM auth."twoFactor"
          WHERE "userId" = $1
        `,
        [
          userId,
        ],
      );

    if (factorDelete.rowCount !== 1) {
      throw new Error(
        "TOTP factor deletion invariant failed.",
      );
    }

    await client.query(
      `
        DELETE FROM app.auth_totp_replay_guard
        WHERE user_id = $1
      `,
      [
        userId,
      ],
    );

    await client.query(
      "DELETE FROM app.auth_recovery_code_set WHERE user_id = $1",
      [userId],
    );

    /*
     * Security downgrade is logout-everywhere.
     * Session-activity rows disappear by FK CASCADE.
     */
    await client.query(
      `
        DELETE FROM auth."session"
        WHERE "userId" = $1
      `,
      [
        userId,
      ],
    );

    await client.query(
      "COMMIT",
    );

    transactionStarted =
      false;

    return true;
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query(
          "ROLLBACK",
        );
      } catch {
        // No successful downgrade is reported.
      }
    }

    throw error;
  } finally {
    client.release();
  }
}

export async function deleteTotpEnrollmentSession(
  database: TotpDatabase,
  sessionId: string,
  userId: string,
): Promise<void> {
  if (
    sessionId.length === 0 ||
    userId.length === 0
  ) {
    throw new Error(
      "Invalid TOTP enrollment session cleanup.",
    );
  }

  const deleted =
    await database.query(
      `
        DELETE FROM auth."session"
        WHERE "id" = $1
          AND "userId" = $2
      `,
      [
        sessionId,
        userId,
      ],
    );

  /*
   * Zero rows is safe: another fail-closed path may
   * already have removed the rotated credential.
   * More than one row would violate session-id
   * uniqueness and must never be silently ignored.
   */
  if (
    deleted.rowCount !== null &&
    deleted.rowCount > 1
  ) {
    throw new Error(
      "TOTP enrollment session cleanup invariant failed.",
    );
  }
}

export async function deleteTotpChallengeSession(
  database: TotpDatabase,
  sessionToken: string,
  userId: string,
): Promise<boolean> {
  if (
    sessionToken.length === 0 ||
    userId.length === 0
  ) {
    throw new Error(
      "Invalid TOTP challenge cleanup.",
    );
  }

  const result =
    await database.query(
      `
        DELETE FROM auth."session"
        WHERE "token" = $1
          AND "userId" = $2
      `,
      [
        sessionToken,
        userId,
      ],
    );

  return result.rowCount === 1;
}
