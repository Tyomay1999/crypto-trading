import { randomUUID } from "node:crypto";
import type { DBAdapter, DBTransactionAdapter, User } from "better-auth";
import {
  getCurrentAdapter,
  runWithTransaction,
} from "@better-auth/core/context";
import type { Pool } from "pg";
import {
  generateRecoveryCodes,
  recoveryDigest,
} from "../auth/recovery-codes.js";
import { createTotpReplayDigest } from "../auth/totp-replay.js";
import { verifyEncryptedTotpCode } from "../auth/totp-replacement.js";

export type RecoverySet = {
  id: string;
  userId: string;
  generation: string;
  createdAt: Date;
  updatedAt: Date;
};
export type RecoveryFactor = {
  id: string;
  userId: string;
  secret: string;
  verified: boolean;
  failedVerificationCount: number | null;
  lockedUntil: Date | null;
};
export type RecoveryProof = {
  userId: string;
  sessionId: string;
  factorId: string;
  encryptedSecret: string;
  accountId: string;
  passwordHash: string;
  acceptedAt: Date;
};

export async function recoveryTransaction<T>(
  adapter: DBAdapter,
  fn: (tx: DBTransactionAdapter) => Promise<T>,
): Promise<T> {
  return runWithTransaction(adapter, async () => {
    const tx = await getCurrentAdapter(adapter);
    // Fail closed if transaction support or async transaction context is lost.
    if (tx === adapter) throw new Error("Recovery transaction is unavailable.");
    return fn(tx);
  });
}

export function findRecoverySet(
  adapter: DBTransactionAdapter,
  userId: string,
): Promise<RecoverySet | null> {
  return adapter.findOne<RecoverySet>({
    model: "recoveryCodeSet",
    where: [{ field: "userId", value: userId }],
  });
}

export async function lockRecoverySecurity(
  adapter: DBTransactionAdapter,
  userId: string,
) {
  // Native PostgreSQL guarded UPDATE locks the same user row as Delta TOTP disable.
  const user = await adapter.incrementOne<User & { twoFactorEnabled: boolean }>(
    {
      model: "user",
      where: [
        { field: "id", value: userId },
        { field: "twoFactorEnabled", value: true },
      ],
      increment: {},
      set: { twoFactorEnabled: true },
    },
  );
  if (!user) return null;
  const factor = await adapter.incrementOne<RecoveryFactor>({
    model: "twoFactor",
    where: [
      { field: "userId", value: userId },
      { field: "verified", value: true },
    ],
    increment: {},
    set: { verified: true },
  });
  return factor ? { user, factor } : null;
}

export async function lockRecoverySet(
  adapter: DBTransactionAdapter,
  userId: string,
): Promise<RecoverySet | null> {
  // Call only after locking the user. All Delta recovery writers use user -> factor -> set.
  const current = await findRecoverySet(adapter, userId);
  if (!current) return null;
  const locked = await adapter.incrementOne<RecoverySet>({
    model: "recoveryCodeSet",
    where: [
      { field: "id", value: current.id },
      { field: "generation", value: current.generation },
    ],
    increment: {},
    set: { generation: current.generation },
  });
  if (!locked) throw new Error("Recovery generation serialization failed.");
  return locked;
}

export async function recoveryStatus(
  adapter: DBTransactionAdapter,
  userId: string,
) {
  const set = await findRecoverySet(adapter, userId);
  const remaining = set
    ? await adapter.count({
        model: "recoveryCode",
        // The set ID is stable across an atomic regeneration. Counting by that
        // identity observes whichever generation is committed after the set read.
        where: [{ field: "setId", value: set.id }],
      })
    : 0;
  if (!Number.isInteger(remaining) || remaining < 0 || remaining > 10)
    throw new Error("Invalid recovery inventory.");
  return { configured: set !== null, remaining };
}

/** Separate durable pre-claim: failure of later recovery work never restores this TOTP proof. */
export async function claimRecoveryManagementProof(
  database: Pick<Pool, "connect">,
  input: {
    userId: string;
    sessionId: string;
    password: string;
    code: string;
    encryptionKey: string;
    replayPepper: string;
  },
  verifyPassword: (input: {
    hash: string;
    password: string;
  }) => Promise<boolean>,
): Promise<RecoveryProof | null> {
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const user = await client.query(
      'SELECT "id" FROM auth."user" WHERE "id" = $1 AND "twoFactorEnabled" = TRUE FOR UPDATE',
      [input.userId],
    );
    const factor = await client.query<{
      id: string;
      secret: string;
      lockedUntil: Date | null;
    }>(
      'SELECT "id", "secret", "lockedUntil" FROM auth."twoFactor" WHERE "userId" = $1 AND "verified" = TRUE FOR UPDATE',
      [input.userId],
    );
    const session = await client.query(
      'SELECT "id" FROM auth."session" WHERE "id" = $1 AND "userId" = $2 AND "expiresAt" > clock_timestamp() FOR UPDATE',
      [input.sessionId, input.userId],
    );
    const account = await client.query<{ id: string; password: string }>(
      'SELECT "id", "password" FROM auth."account" WHERE "userId" = $1 AND "providerId" = $2 FOR UPDATE',
      [input.userId, "credential"],
    );
    const tf = factor.rows[0];
    const credential = account.rows[0];
    if (
      user.rowCount !== 1 ||
      factor.rowCount !== 1 ||
      session.rowCount !== 1 ||
      account.rowCount !== 1 ||
      !credential?.password ||
      (tf.lockedUntil && tf.lockedUntil.getTime() > Date.now()) ||
      !(await verifyPassword({
        hash: credential.password,
        password: input.password,
      })) ||
      !(await verifyEncryptedTotpCode(
        input.encryptionKey,
        tf.secret,
        input.code,
      ))
    ) {
      await client.query("ROLLBACK");
      return null;
    }
    const acceptedAt = new Date();
    const digest = createTotpReplayDigest(
      input.replayPepper,
      input.userId,
      input.code,
    );
    // Same digest, expiry and ON CONFLICT semantics as the accepted replay ledger.
    await client.query(
      "DELETE FROM app.auth_totp_replay_guard WHERE user_id = $1 AND expires_at <= $2",
      [input.userId, acceptedAt],
    );
    const claim = await client.query(
      `INSERT INTO app.auth_totp_replay_guard
      (user_id, code_digest, accepted_at, expires_at) VALUES ($1, $2, $3, $4)
      ON CONFLICT (user_id, code_digest) DO NOTHING RETURNING user_id`,
      [
        input.userId,
        digest,
        acceptedAt,
        new Date(acceptedAt.getTime() + 5 * 60 * 1000),
      ],
    );
    await client.query("COMMIT");
    return claim.rowCount === 1
      ? {
          userId: input.userId,
          sessionId: input.sessionId,
          factorId: tf.id,
          encryptedSecret: tf.secret,
          accountId: credential.id,
          passwordHash: credential.password,
          acceptedAt,
        }
      : null;
  } catch {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* Fail closed. */
    }
    throw new Error("Recovery management proof storage failed.");
  } finally {
    client.release();
  }
}

export async function replaceRecoveryCodes(
  adapter: DBAdapter,
  proof: RecoveryProof,
  expectedGeneration: string | null,
  pepper: string,
  currentTotp: { encryptionKey: string; code: string },
): Promise<{ codes: string[] } | null> {
  return recoveryTransaction(adapter, async (tx) => {
    const security = await lockRecoverySecurity(tx, proof.userId);
    if (
      !security ||
      security.factor.id !== proof.factorId ||
      security.factor.secret !== proof.encryptedSecret ||
      (security.factor.lockedUntil &&
        new Date(security.factor.lockedUntil).getTime() > Date.now())
    )
      return null;
    const session = await tx.incrementOne<{ expiresAt: Date }>({
      model: "session",
      where: [
        { field: "id", value: proof.sessionId },
        { field: "userId", value: proof.userId },
      ],
      increment: {},
      set: { userId: proof.userId },
    });
    const account = await tx.incrementOne({
      model: "account",
      where: [
        { field: "id", value: proof.accountId },
        { field: "userId", value: proof.userId },
        { field: "providerId", value: "credential" },
        { field: "password", value: proof.passwordHash },
      ],
      increment: {},
      set: { password: proof.passwordHash },
    });
    const current = await lockRecoverySet(tx, proof.userId);
    // Time and generation are checked after all possible lock waits.
    if (
      !session ||
      new Date(session.expiresAt).getTime() <= Date.now() ||
      !account ||
      Date.now() - proof.acceptedAt.getTime() > 30_000 ||
      (current?.generation ?? null) !== expectedGeneration ||
      !(await verifyEncryptedTotpCode(
        currentTotp.encryptionKey,
        proof.encryptedSecret,
        currentTotp.code,
      ))
    )
      return null;
    const generation = randomUUID();
    const codes = generateRecoveryCodes();
    let setId: string;
    if (current) {
      await tx.deleteMany({
        model: "recoveryCode",
        where: [{ field: "setId", value: current.id }],
      });
      const changed = await tx.incrementOne<RecoverySet>({
        model: "recoveryCodeSet",
        where: [
          { field: "id", value: current.id },
          { field: "generation", value: expectedGeneration },
        ],
        increment: {},
        set: { generation, updatedAt: new Date() },
      });
      if (!changed) throw new Error("Recovery generation replacement failed.");
      setId = changed.id;
    } else {
      const created = await tx.create<RecoverySet>({
        model: "recoveryCodeSet",
        data: {
          userId: proof.userId,
          generation,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });
      if (!created) throw new Error("Recovery generation creation failed.");
      setId = created.id;
    }
    for (const code of codes) {
      const row = await tx.create({
        model: "recoveryCode",
        data: {
          setId,
          generation,
          codeDigest: recoveryDigest(pepper, proof.userId, generation, code),
        },
      });
      if (!row) throw new Error("Recovery credential insertion failed.");
    }
    // runWithTransaction resolves only after COMMIT; plaintext is never returned on failure.
    return { codes };
  });
}

export async function consumeRecoveryCode(
  tx: DBTransactionAdapter,
  set: RecoverySet,
  pepper: string,
  code: string,
): Promise<boolean> {
  const consumed = await tx.consumeOne({
    model: "recoveryCode",
    where: [
      { field: "setId", value: set.id },
      { field: "generation", value: set.generation },
      {
        field: "codeDigest",
        value: recoveryDigest(pepper, set.userId, set.generation, code),
      },
    ],
  });
  return consumed !== null;
}
