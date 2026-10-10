import { getSessionFromCtx } from "better-auth/api";
import { expireCookie, setSessionCookie } from "better-auth/cookies";
import type { User } from "better-auth";
import { normalizeRecoveryCode } from "./recovery-codes.js";
import {
  consumeRecoveryCode,
  lockRecoverySecurity,
  lockRecoverySet,
  recoveryTransaction,
} from "../storage/recovery-codes.js";
import { insertRecoverySessionMarker } from "../storage/recovery-session-marker.js";

export type RecoveryEndpointContext = Parameters<typeof getSessionFromCtx>[0];

type RecoveryInternalAdapter = Pick<
  RecoveryEndpointContext["context"]["internalAdapter"],
  | "consumeVerificationValue"
  | "createSession"
  | "createVerificationValue"
  | "findVerificationValue"
>;

export type RecoveryChallengeResult = Readonly<{
  session: NonNullable<
    Awaited<ReturnType<RecoveryInternalAdapter["createSession"]>>
  >;
  user: User;
}>;
export type RecoveryChallengeTransactionResult =
  RecoveryChallengeResult | "account_locked" | null;
export type RecoveryChallengeOutcome =
  "verified" | "rejected" | "account_locked";

export async function completeRecoveryChallengeTransaction(
  adapter: RecoveryEndpointContext["context"]["adapter"],
  internal: RecoveryInternalAdapter,
  pepper: string,
  code: string,
  challenge: string,
  dontRemember: boolean,
): Promise<RecoveryChallengeTransactionResult> {
  return recoveryTransaction(adapter, async (transactionAdapter) => {
    const attemptKey = `2fa-attempts-${challenge}`;

    /*
     * This consumes the shared TOTP/recovery
     * attempt row through Better Auth's identifier
     * hashing and current-transaction adapter.
     * PostgreSQL lock waiting is intentional.
     */
    const attempt = await internal.consumeVerificationValue(attemptKey);

    if (!attempt) {
      return null;
    }

    const attemptCount = /^[0-5]$/.test(attempt.value)
      ? Number(attempt.value)
      : 5;

    if (attemptCount >= 5) {
      await internal.consumeVerificationValue(challenge);

      return null;
    }

    let pending = await internal.findVerificationValue(challenge);

    if (!pending || new Date(pending.expiresAt).getTime() <= Date.now()) {
      return null;
    }

    const userId = pending.value;

    const security = await lockRecoverySecurity(transactionAdapter, userId);

    if (!security) {
      return null;
    }

    const set = await lockRecoverySet(transactionAdapter, userId);

    /*
     * Re-read every challenge decision after
     * the user/factor/set serialization points.
     * A waiter never authorizes from a pre-lock
     * snapshot.
     */
    pending = await internal.findVerificationValue(challenge);

    if (
      !pending ||
      pending.value !== userId ||
      new Date(pending.expiresAt).getTime() <= Date.now() ||
      new Date(attempt.expiresAt).getTime() <= Date.now()
    ) {
      return null;
    }

    const rearmAttempt = async (value: number): Promise<void> => {
      const row = await internal.createVerificationValue({
        identifier: attemptKey,
        value: String(value),
        expiresAt: pending!.expiresAt,
      });

      if (!row) {
        throw new Error("Recovery attempt rearm failed.");
      }
    };

    const factor = security.factor;

    if (
      factor.lockedUntil &&
      new Date(factor.lockedUntil).getTime() > Date.now()
    ) {
      await rearmAttempt(attemptCount);

      return "account_locked";
    }

    if (
      factor.lockedUntil ||
      !Number.isInteger(factor.failedVerificationCount)
    ) {
      await transactionAdapter.update({
        model: "twoFactor",
        where: [
          {
            field: "id",
            value: factor.id,
          },
        ],
        update: {
          failedVerificationCount: 0,
          lockedUntil: null,
        },
      });
    }

    const valid =
      set !== null &&
      (await consumeRecoveryCode(transactionAdapter, set, pepper, code));

    if (!valid) {
      const failed = await transactionAdapter.incrementOne<{
        failedVerificationCount: number;
      }>({
        model: "twoFactor",
        where: [
          {
            field: "id",
            value: factor.id,
          },
        ],
        increment: {
          failedVerificationCount: 1,
        },
      });

      if (!failed || !Number.isInteger(failed.failedVerificationCount)) {
        throw new Error("Recovery failure accounting failed.");
      }

      if (failed.failedVerificationCount >= 10) {
        await transactionAdapter.update({
          model: "twoFactor",
          where: [
            {
              field: "id",
              value: factor.id,
            },
          ],
          update: {
            lockedUntil: new Date(Date.now() + 15 * 60 * 1000),
          },
        });
      }

      await rearmAttempt(attemptCount + 1);

      /*
       * Credential rejection is a committed
       * result, never a rollback exception.
       */
      return null;
    }

    const consumedChallenge =
      await internal.consumeVerificationValue(challenge);

    if (
      !consumedChallenge ||
      consumedChallenge.value !== userId ||
      new Date(consumedChallenge.expiresAt).getTime() <= Date.now()
    ) {
      throw new Error("Recovery challenge binding changed.");
    }

    await transactionAdapter.update({
      model: "twoFactor",
      where: [
        {
          field: "id",
          value: factor.id,
        },
      ],
      update: {
        failedVerificationCount: 0,
        lockedUntil: null,
      },
    });

    const session = await internal.createSession(userId, dontRemember);

    if (!session) {
      throw new Error("Recovery session creation failed.");
    }

    await insertRecoverySessionMarker(
      transactionAdapter,
      session.id,
      new Date(),
    );

    return {
      session,
      user: security.user,
    };
  });
}

/** No HTTP credential is assembled until the entire durable transition commits. */
export async function verifyRecoveryChallenge(
  ctx: RecoveryEndpointContext,
  pepper: string,
  code: string,
): Promise<RecoveryChallengeOutcome> {
  if (normalizeRecoveryCode(code) === null) return "rejected";
  // getSessionFromCtx intentionally catches session-store errors in 1.7.3.
  // An explicit authoritative read prevents that behavior from opening this boundary.
  const existingToken = await ctx.getSignedCookie(
    ctx.context.authCookies.sessionToken.name,
    ctx.context.secret,
  );
  if (existingToken) {
    const existing =
      await ctx.context.internalAdapter.findSession(existingToken);
    if (existing && new Date(existing.session.expiresAt).getTime() > Date.now())
      return "rejected";
  }
  if (
    await getSessionFromCtx(ctx, {
      disableCookieCache: true,
      disableRefresh: true,
    })
  )
    return "rejected";
  // Public cookie factory; this suffix and signed format are pinned to installed 1.7.3.
  const cookie = ctx.context.createAuthCookie("two_factor");
  const challenge = await ctx.getSignedCookie(cookie.name, ctx.context.secret);
  if (!challenge || !/^2fa-[A-Za-z0-9_-]{16,128}$/.test(challenge))
    return "rejected";
  const dontRemember = !!(await ctx.getSignedCookie(
    ctx.context.authCookies.dontRememberToken.name,
    ctx.context.secret,
  ));
  const internal = ctx.context.internalAdapter;
  const result = await completeRecoveryChallengeTransaction(
    ctx.context.adapter,
    internal,
    pepper,
    code,
    challenge,
    dontRemember,
  );
  if (!result) return "rejected";
  if (result === "account_locked") return result;
  // runWithTransaction has resolved/COMMIT has completed. No trusted-device issuance.
  await setSessionCookie(ctx, result, dontRemember);
  expireCookie(ctx, cookie);
  return "verified";
}
