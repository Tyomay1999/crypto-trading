import type {
  Pool,
  PoolClient,
} from "pg";

type TotpReplacementDatabase =
  Pick<
    Pool,
    "connect" | "query"
  >;

const MAX_REPLACEMENT_FAILURES = 5;

export type TotpReplacementState = {
  replacementId: string;
  encryptedSecret: string;
  failedVerificationCount: number;
  expiresAt: Date;
};

export async function createOrReplaceTotpReplacement(
  pool: TotpReplacementDatabase,
  userId: string,
  replacementId: string,
  encryptedSecret: string,
  createdAt: Date,
  expiresAt: Date,
): Promise<void> {
  if (
    userId.length === 0 ||
    replacementId.length < 24 ||
    encryptedSecret.length === 0 ||
    !Number.isFinite(
      createdAt.getTime(),
    ) ||
    !Number.isFinite(
      expiresAt.getTime(),
    ) ||
    expiresAt <= createdAt
  ) {
    throw new Error(
      "Invalid TOTP replacement state.",
    );
  }

  await pool.query(
    `
      INSERT INTO app.auth_totp_replacement (
        user_id,
        replacement_id,
        encrypted_secret,
        failed_verification_count,
        created_at,
        expires_at
      )
      VALUES (
        $1,
        $2,
        $3,
        0,
        $4,
        $5
      )
      ON CONFLICT (user_id)
      DO UPDATE SET
        replacement_id =
          EXCLUDED.replacement_id,
        encrypted_secret =
          EXCLUDED.encrypted_secret,
        failed_verification_count =
          0,
        created_at =
          EXCLUDED.created_at,
        expires_at =
          EXCLUDED.expires_at
    `,
    [
      userId,
      replacementId,
      encryptedSecret,
      createdAt,
      expiresAt,
    ],
  );
}

export async function getTotpReplacement(
  pool: TotpReplacementDatabase,
  userId: string,
  replacementId: string,
  observedAt: Date,
): Promise<TotpReplacementState | null> {
  if (
    userId.length === 0 ||
    replacementId.length < 24 ||
    !Number.isFinite(
      observedAt.getTime(),
    )
  ) {
    return null;
  }

  await pool.query(
    `
      DELETE FROM app.auth_totp_replacement
      WHERE
        user_id = $1
        AND expires_at <= $2
    `,
    [
      userId,
      observedAt,
    ],
  );

  const result =
    await pool.query<{
      replacement_id: string;
      encrypted_secret: string;
      failed_verification_count: number;
      expires_at: Date;
    }>(
      `
        SELECT
          replacement_id,
          encrypted_secret,
          failed_verification_count,
          expires_at
        FROM app.auth_totp_replacement
        WHERE
          user_id = $1
          AND replacement_id = $2
          AND expires_at > $3
          AND failed_verification_count < $4
        LIMIT 1
      `,
      [
        userId,
        replacementId,
        observedAt,
        MAX_REPLACEMENT_FAILURES,
      ],
    );

  if (result.rowCount !== 1) {
    return null;
  }

  const row = result.rows[0];

  return {
    replacementId:
      row.replacement_id,

    encryptedSecret:
      row.encrypted_secret,

    failedVerificationCount:
      row.failed_verification_count,

    expiresAt:
      row.expires_at,
  };
}

export async function getActiveTotpEncryptedSecret(
  pool: TotpReplacementDatabase,
  userId: string,
): Promise<string | null> {
  const result =
    await pool.query<{
      secret: string;
    }>(
      `
        SELECT tf."secret"
        FROM auth."twoFactor" tf
        JOIN auth."user" u
          ON u."id" = tf."userId"
        WHERE
          tf."userId" = $1
          AND tf."verified" = TRUE
          AND u."twoFactorEnabled" = TRUE
        LIMIT 1
      `,
      [
        userId,
      ],
    );

  if (result.rowCount !== 1) {
    return null;
  }

  return result.rows[0].secret;
}

export async function recordTotpReplacementFailure(
  pool: TotpReplacementDatabase,
  userId: string,
  replacementId: string,
  observedAt: Date,
): Promise<void> {
  const client =
    await pool.connect();

  try {
    await client.query("BEGIN");

    const result =
      await client.query<{
        failed_verification_count:
          number;
      }>(
        `
          UPDATE app.auth_totp_replacement
          SET
            failed_verification_count =
              failed_verification_count + 1
          WHERE
            user_id = $1
            AND replacement_id = $2
            AND expires_at > $3
          RETURNING
            failed_verification_count
        `,
        [
          userId,
          replacementId,
          observedAt,
        ],
      );

    if (
      result.rowCount === 1 &&
      result.rows[0]
        .failed_verification_count >=
          MAX_REPLACEMENT_FAILURES
    ) {
      await client.query(
        `
          DELETE FROM app.auth_totp_replacement
          WHERE
            user_id = $1
            AND replacement_id = $2
        `,
        [
          userId,
          replacementId,
        ],
      );
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

type FinalizeTotpReplacementInput = {
  userId: string;
  replacementId: string;
  currentSessionId: string;
  expectedEncryptedSecret: string;
  replayDigest: string;
  acceptedAt: Date;
  replayExpiresAt: Date;
};

async function lockPendingReplacement(
  client: PoolClient,
  input: FinalizeTotpReplacementInput,
): Promise<boolean> {
  const result =
    await client.query<{
      encrypted_secret: string;
      failed_verification_count:
        number;
    }>(
      `
        SELECT
          encrypted_secret,
          failed_verification_count
        FROM app.auth_totp_replacement
        WHERE
          user_id = $1
          AND replacement_id = $2
          AND expires_at > $3
        FOR UPDATE
      `,
      [
        input.userId,
        input.replacementId,
        input.acceptedAt,
      ],
    );

  if (result.rowCount !== 1) {
    return false;
  }

  const row = result.rows[0];

  return (
    row.encrypted_secret ===
      input.expectedEncryptedSecret &&
    row.failed_verification_count <
      MAX_REPLACEMENT_FAILURES
  );
}

export async function finalizeTotpReplacement(
  pool: TotpReplacementDatabase,
  input: FinalizeTotpReplacementInput,
): Promise<boolean> {
  if (
    input.userId.length === 0 ||
    input.replacementId.length < 24 ||
    input.currentSessionId.length === 0 ||
    input.expectedEncryptedSecret.length === 0 ||
    input.replayDigest.length !== 64 ||
    !Number.isFinite(
      input.acceptedAt.getTime(),
    ) ||
    !Number.isFinite(
      input.replayExpiresAt.getTime(),
    ) ||
    input.replayExpiresAt <=
      input.acceptedAt
  ) {
    throw new Error(
      "Invalid TOTP replacement finalization.",
    );
  }

  const client =
    await pool.connect();

  try {
    await client.query("BEGIN");

    const pendingAccepted =
      await lockPendingReplacement(
        client,
        input,
      );

    if (!pendingAccepted) {
      await client.query("ROLLBACK");
      return false;
    }

    const active =
      await client.query(
        `
          SELECT tf."id"
          FROM auth."twoFactor" tf
          JOIN auth."user" u
            ON u."id" = tf."userId"
          WHERE
            tf."userId" = $1
            AND tf."verified" = TRUE
            AND u."twoFactorEnabled" = TRUE
          FOR UPDATE OF tf, u
        `,
        [
          input.userId,
        ],
      );

    if (active.rowCount !== 1) {
      await client.query("ROLLBACK");
      return false;
    }

    await client.query(
      `
        DELETE FROM app.auth_totp_replay_guard
        WHERE
          user_id = $1
          AND expires_at <= $2
      `,
      [
        input.userId,
        input.acceptedAt,
      ],
    );

    const replay =
      await client.query(
        `
          SELECT 1
          FROM app.auth_totp_replay_guard
          WHERE
            user_id = $1
            AND code_digest = $2
            AND expires_at > $3
          LIMIT 1
        `,
        [
          input.userId,
          input.replayDigest,
          input.acceptedAt,
        ],
      );

    if (replay.rowCount !== 0) {
      await client.query("ROLLBACK");
      return false;
    }

    /*
     * The old replay ledger belongs to the old
     * authenticator generation and is no longer
     * meaningful after the factor swap.
     */
    await client.query(
      `
        DELETE FROM app.auth_totp_replay_guard
        WHERE user_id = $1
      `,
      [
        input.userId,
      ],
    );

    const updated =
      await client.query(
        `
          UPDATE auth."twoFactor"
          SET
            "secret" = $2,
            "verified" = TRUE,
            "failedVerificationCount" = 0,
            "lockedUntil" = NULL
          WHERE
            "userId" = $1
            AND "verified" = TRUE
        `,
        [
          input.userId,
          input.expectedEncryptedSecret,
        ],
      );

    if (updated.rowCount !== 1) {
      await client.query("ROLLBACK");
      return false;
    }

    await client.query(
      `
        UPDATE auth."user"
        SET
          "twoFactorEnabled" = TRUE
        WHERE "id" = $1
      `,
      [
        input.userId,
      ],
    );

    await client.query(
      `
        INSERT INTO app.auth_totp_replay_guard (
          user_id,
          code_digest,
          accepted_at,
          expires_at
        )
        VALUES (
          $1,
          $2,
          $3,
          $4
        )
      `,
      [
        input.userId,
        input.replayDigest,
        input.acceptedAt,
        input.replayExpiresAt,
      ],
    );

    await client.query(
      `
        DELETE FROM app.auth_totp_replacement
        WHERE
          user_id = $1
          AND replacement_id = $2
      `,
      [
        input.userId,
        input.replacementId,
      ],
    );

    /*
     * Preserve only the security-proven current
     * browser session. Every other durable session
     * must authenticate against the new factor.
     */
    await client.query(
      `
        DELETE FROM auth."session"
        WHERE
          "userId" = $1
          AND "id" <> $2
      `,
      [
        input.userId,
        input.currentSessionId,
      ],
    );

    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
