import { createHmac } from "node:crypto";
import type { Pool } from "pg";

export const RECOVERY_LIMITS = {
  challengeIp: { limit: 3, seconds: 10 },
  mutationIp: { limit: 5, seconds: 900 },
  mutationUser: { limit: 5, seconds: 900 },
  statusIp: { limit: 60, seconds: 60 },
} as const;
export const RECOVERY_RATE_LIMIT_IDENTIFIER_BITS = 256;
export type RecoveryLimitScope = keyof typeof RECOVERY_LIMITS;

export function recoveryBucketId(
  pepper: string,
  scope: RecoveryLimitScope,
  source: string,
): string {
  if (
    Buffer.byteLength(pepper, "utf8") < 32 ||
    !source ||
    source.length > 256 ||
    !(scope in RECOVERY_LIMITS)
  ) {
    throw new Error("Invalid recovery limiter input.");
  }
  // The exact persisted identity retains the full keyed 256-bit source digest.
  return createHmac("sha256", Buffer.from(pepper, "utf8"))
    .update(
      JSON.stringify(["delta:recovery-limit:bucket:v2", scope, source]),
      "utf8",
    )
    .digest("hex");
}

export async function takeRecoveryRateLimit(
  database: Pick<Pool, "query">,
  pepper: string,
  scope: RecoveryLimitScope,
  source: string,
): Promise<boolean> {
  const id = recoveryBucketId(pepper, scope, source);
  const { limit, seconds } = RECOVERY_LIMITS[scope];
  // One parameterized atomic UPSERT across processes. Opportunistic bounded cleanup
  // removes expired full-identity rows without requiring a runtime job.
  try {
    await database.query(`DELETE FROM app.auth_recovery_rate_limit WHERE id IN
      (SELECT id FROM app.auth_recovery_rate_limit WHERE expires_at <= clock_timestamp()
       ORDER BY expires_at LIMIT 64 FOR UPDATE SKIP LOCKED)`);
    const result = await database.query(
      `INSERT INTO app.auth_recovery_rate_limit (id, hits, expires_at)
      VALUES ($1, 1, clock_timestamp() + $2 * interval '1 second')
      ON CONFLICT (id) DO UPDATE SET
        hits = CASE WHEN app.auth_recovery_rate_limit.expires_at <= clock_timestamp() THEN 1 ELSE app.auth_recovery_rate_limit.hits + 1 END,
        expires_at = CASE WHEN app.auth_recovery_rate_limit.expires_at <= clock_timestamp()
          THEN clock_timestamp() + $2 * interval '1 second' ELSE app.auth_recovery_rate_limit.expires_at END
      WHERE app.auth_recovery_rate_limit.expires_at <= clock_timestamp() OR app.auth_recovery_rate_limit.hits < $3
      RETURNING id`,
      [id, seconds, limit],
    );
    return result.rowCount === 1;
  } catch {
    throw new Error("Recovery rate-limit storage unavailable.");
  }
}
