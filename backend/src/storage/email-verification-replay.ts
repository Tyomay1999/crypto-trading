import type {
  Pool,
} from "pg";

type EmailVerificationReplayClaim =
  Readonly<{
    userId: string;
    tokenDigest: string;
    acceptedAt: Date;
    expiresAt: Date;
  }>;

function assertValidDate(
  value: Date,
  name: string,
): void {
  if (
    !(value instanceof Date) ||
    Number.isNaN(
      value.getTime(),
    )
  ) {
    throw new Error(
      `${name} is invalid.`,
    );
  }
}

function validateClaim(
  claim: EmailVerificationReplayClaim,
): void {
  if (
    claim.userId.length < 1 ||
    claim.userId.length > 256
  ) {
    throw new Error(
      "Email verification replay user ID is invalid.",
    );
  }

  if (
    !/^[0-9a-f]{64}$/.test(
      claim.tokenDigest,
    )
  ) {
    throw new Error(
      "Email verification replay digest is invalid.",
    );
  }

  assertValidDate(
    claim.acceptedAt,
    "acceptedAt",
  );

  assertValidDate(
    claim.expiresAt,
    "expiresAt",
  );

  if (
    claim.expiresAt.getTime() <=
    claim.acceptedAt.getTime()
  ) {
    throw new Error(
      "Email verification replay expiry is invalid.",
    );
  }
}

/*
 * Claims one cryptographically valid verification
 * credential exactly once.
 *
 * Claiming happens before Better Auth mutates the
 * user. This is deliberately fail-closed: if the
 * downstream verification operation subsequently
 * fails, this credential remains consumed and the
 * user must request a fresh verification link.
 *
 * That trade-off is intentional because allowing a
 * retry after an uncertain failure would reopen the
 * concurrent replay race this guard exists to close.
 */
export async function claimEmailVerificationReplayToken(
  database: Pool,
  claim: EmailVerificationReplayClaim,
): Promise<boolean> {
  validateClaim(
    claim,
  );

  const client =
    await database.connect();

  let transactionOpen =
    false;

  try {
    await client.query(
      "BEGIN",
    );

    transactionOpen =
      true;

    /*
     * Expired replay evidence has no remaining
     * authorization value and can be removed
     * opportunistically using the expiry index.
     */
    await client.query(
      `
        DELETE FROM
          app.auth_email_verification_replay_guard
        WHERE expires_at <= $1
      `,
      [
        claim.acceptedAt,
      ],
    );

    const inserted =
      await client.query<{
        token_digest: string;
      }>(
        `
          INSERT INTO
            app.auth_email_verification_replay_guard (
              user_id,
              token_digest,
              accepted_at,
              expires_at
            )
          VALUES (
            $1,
            $2,
            $3,
            $4
          )
          ON CONFLICT (
            user_id,
            token_digest
          )
          DO NOTHING
          RETURNING
            token_digest
        `,
        [
          claim.userId,
          claim.tokenDigest,
          claim.acceptedAt,
          claim.expiresAt,
        ],
      );

    await client.query(
      "COMMIT",
    );

    transactionOpen =
      false;

    return (
      inserted.rowCount === 1
    );
  } catch (error) {
    if (transactionOpen) {
      try {
        await client.query(
          "ROLLBACK",
        );
      } catch {
        /*
         * Preserve the original database failure.
         */
      }
    }

    throw error;
  } finally {
    client.release();
  }
}
