import { createHmac } from "node:crypto";
import type { Pool } from "pg";

export const PASSKEY_RATE_LIMIT_IDENTIFIER_BITS = 256;
export const PASSKEY_RATE_LIMIT_MAX_HITS = 60;
export const PASSKEY_RATE_LIMIT_POLICY_SOURCE =
  "DELTA_RECOVERY_CHALLENGE_AND_MUTATION_BUDGETS" as const;

export const PASSKEY_RATE_LIMIT_POLICIES = {
  registrationOptions: { limit: 3, seconds: 10 },
  registrationVerify: { limit: 5, seconds: 900 },
  authenticationOptions: { limit: 3, seconds: 10 },
  authenticationVerify: { limit: 5, seconds: 900 },
  managementFreshProof: { limit: 5, seconds: 900 },
  managementList: { limit: 60, seconds: 60 },
  managementRename: { limit: 5, seconds: 900 },
  managementDelete: { limit: 5, seconds: 900 },
} as const;

export type PasskeyRateLimitOperation =
  keyof typeof PASSKEY_RATE_LIMIT_POLICIES;
export type PasskeyRateLimitIdentityKind = "network" | "user";

export const PASSKEY_RATE_LIMIT_SCOPES = [
  "registrationOptionsIp",
  "registrationOptionsUser",
  "registrationVerifyIp",
  "registrationVerifyUser",
  "registrationVerifyChallenge",
  "authenticationOptionsIp",
  "authenticationOptionsAccount",
  "authenticationVerifyIp",
  "authenticationVerifyChallenge",
  "authenticationVerifyCredentialUser",
  "managementDeleteUser",
  "managementRenameUser",
  "managementListUser",
  "managementFreshProofIp",
  "managementFreshProofUser",
] as const;

export type PasskeyRateLimitScope =
  (typeof PASSKEY_RATE_LIMIT_SCOPES)[number];

export type PasskeyRateLimitRule = {
  limit: number;
  seconds: number;
};

const PASSKEY_OPERATION_SCOPES = {
  registrationOptions: {
    network: "registrationOptionsIp",
    user: "registrationOptionsUser",
  },
  registrationVerify: {
    network: "registrationVerifyIp",
    user: "registrationVerifyUser",
  },
  authenticationOptions: {
    network: "authenticationOptionsIp",
  },
  authenticationVerify: {
    network: "authenticationVerifyIp",
  },
  managementFreshProof: {
    network: "managementFreshProofIp",
    user: "managementFreshProofUser",
  },
  managementList: {
    user: "managementListUser",
  },
  managementRename: {
    user: "managementRenameUser",
  },
  managementDelete: {
    user: "managementDeleteUser",
  },
} as const satisfies Record<
  PasskeyRateLimitOperation,
  Partial<Record<PasskeyRateLimitIdentityKind, PasskeyRateLimitScope>>
>;

export function passkeyBucketId(
  key: string,
  scope: PasskeyRateLimitScope,
  source: string,
): string {
  if (
    Buffer.byteLength(key, "utf8") < 32 ||
    !PASSKEY_RATE_LIMIT_SCOPES.includes(scope) ||
    !source ||
    source.length > 256
  ) {
    throw new Error("Invalid passkey limiter input.");
  }

  return createHmac("sha256", Buffer.from(key, "utf8"))
    .update(
      JSON.stringify(["delta:passkey-limit:bucket:v1", scope, source]),
      "utf8",
    )
    .digest("hex");
}

export async function takePasskeyRateLimit(
  database: Pick<Pool, "query">,
  key: string,
  scope: PasskeyRateLimitScope,
  source: string,
  rule: PasskeyRateLimitRule,
): Promise<boolean> {
  if (
    !Number.isInteger(rule.limit) ||
    rule.limit < 1 ||
    rule.limit > PASSKEY_RATE_LIMIT_MAX_HITS ||
    !Number.isInteger(rule.seconds) ||
    rule.seconds < 1 ||
    rule.seconds > 86_400
  ) {
    throw new Error("Invalid passkey rate-limit rule.");
  }

  const id = passkeyBucketId(key, scope, source);

  try {
    await database.query(`DELETE FROM app.auth_passkey_rate_limit WHERE id IN
      (SELECT id FROM app.auth_passkey_rate_limit WHERE expires_at <= clock_timestamp()
       ORDER BY expires_at LIMIT 64 FOR UPDATE SKIP LOCKED)`);
    const result = await database.query(
      `INSERT INTO app.auth_passkey_rate_limit (id, hits, expires_at)
      VALUES ($1, 1, clock_timestamp() + $2 * interval '1 second')
      ON CONFLICT (id) DO UPDATE SET
        hits = CASE WHEN app.auth_passkey_rate_limit.expires_at <= clock_timestamp() THEN 1 ELSE app.auth_passkey_rate_limit.hits + 1 END,
        expires_at = CASE WHEN app.auth_passkey_rate_limit.expires_at <= clock_timestamp()
          THEN clock_timestamp() + $2 * interval '1 second' ELSE app.auth_passkey_rate_limit.expires_at END
      WHERE app.auth_passkey_rate_limit.expires_at <= clock_timestamp() OR app.auth_passkey_rate_limit.hits < $3
      RETURNING id`,
      [id, rule.seconds, rule.limit],
    );
    return result.rowCount === 1;
  } catch {
    throw new Error("Passkey rate-limit storage unavailable.");
  }
}

export async function takePasskeyOperationRateLimit(
  database: Pick<Pool, "query">,
  key: string,
  operation: PasskeyRateLimitOperation,
  identityKind: PasskeyRateLimitIdentityKind,
  source: string,
): Promise<boolean> {
  const policy = PASSKEY_RATE_LIMIT_POLICIES[operation];
  const operationScopes: Partial<
    Record<PasskeyRateLimitIdentityKind, PasskeyRateLimitScope>
  > = PASSKEY_OPERATION_SCOPES[operation];
  const scope = operationScopes?.[identityKind];
  if (!policy || !scope) {
    throw new Error("Invalid passkey rate-limit operation.");
  }
  return takePasskeyRateLimit(database, key, scope, source, policy);
}

export function createPasskeyDurableRateLimiter(
  database: Pick<Pool, "query">,
  key: string,
) {
  if (Buffer.byteLength(key, "utf8") < 32) {
    throw new Error("Invalid passkey limiter key.");
  }
  return async (input: Readonly<{
    operation: PasskeyRateLimitOperation;
    identity: Readonly<{
      kind: PasskeyRateLimitIdentityKind;
      source: string;
    }>;
  }>): Promise<boolean> =>
    takePasskeyOperationRateLimit(
      database,
      key,
      input.operation,
      input.identity.kind,
      input.identity.source,
    );
}
