import {
  createHash,
} from "node:crypto";

import {
  APIError,
  createAuthMiddleware,
} from "better-auth/api";
import {
  verifyJWT,
} from "better-auth/crypto";
import type {
  Pool,
} from "pg";

import {
  claimEmailVerificationReplayToken,
} from "../storage/email-verification-replay.js";

const EMAIL_VERIFICATION_REPLAY_DOMAIN =
  "delta:email-verification-replay:v1";

const MAX_EMAIL_LENGTH =
  320;

const MAX_REQUEST_TYPE_LENGTH =
  128;

const MAX_VERIFICATION_TOKEN_LENGTH =
  8192;

export type EmailVerificationReplayPayload =
  Readonly<{
    email?: unknown;
    updateTo?: unknown;
    requestType?: unknown;
    exp?: unknown;
  }>;

export type ParsedEmailVerificationReplayPayload =
  Readonly<{
    email: string;
    expiresAt: Date;
    isEmailChange: boolean;
  }>;

function validOptionalString(
  value: unknown,
  maxLength: number,
): boolean {
  return (
    value === undefined ||
    (
      typeof value === "string" &&
      value.length > 0 &&
      value.length <= maxLength
    )
  );
}

export function parseEmailVerificationReplayPayload(
  payload: EmailVerificationReplayPayload,
  observedAt: Date,
): ParsedEmailVerificationReplayPayload |
  null {
  if (
    !(observedAt instanceof Date) ||
    Number.isNaN(
      observedAt.getTime(),
    )
  ) {
    throw new Error(
      "Email verification observation time is invalid.",
    );
  }

  if (
    typeof payload.email !== "string" ||
    payload.email.length < 1 ||
    payload.email.length >
      MAX_EMAIL_LENGTH ||
    payload.email !==
      payload.email.trim()
  ) {
    return null;
  }

  if (
    !validOptionalString(
      payload.updateTo,
      MAX_EMAIL_LENGTH,
    )
  ) {
    return null;
  }

  if (
    !validOptionalString(
      payload.requestType,
      MAX_REQUEST_TYPE_LENGTH,
    )
  ) {
    return null;
  }

  if (
    typeof payload.exp !== "number" ||
    !Number.isSafeInteger(
      payload.exp,
    ) ||
    payload.exp <= 0
  ) {
    return null;
  }

  const expiryMilliseconds =
    payload.exp * 1000;

  if (
    !Number.isSafeInteger(
      expiryMilliseconds,
    )
  ) {
    return null;
  }

  const expiresAt =
    new Date(
      expiryMilliseconds,
    );

  if (
    Number.isNaN(
      expiresAt.getTime(),
    ) ||
    expiresAt.getTime() <=
      observedAt.getTime()
  ) {
    return null;
  }

  return Object.freeze({
    email:
      payload.email.toLowerCase(),

    expiresAt,

    /*
     * Better Auth uses updateTo for its email-change
     * verification flows. A currently verified user
     * is therefore not sufficient reason to reject
     * those tokens.
     */
    isEmailChange:
      payload.updateTo !== undefined,
  });
}

export function createEmailVerificationReplayDigest(
  userId: string,
  token: string,
): string {
  if (
    userId.length < 1 ||
    userId.length > 256
  ) {
    throw new Error(
      "Email verification replay user ID is invalid.",
    );
  }

  if (
    token.length < 1 ||
    token.length >
      MAX_VERIFICATION_TOKEN_LENGTH
  ) {
    throw new Error(
      "Email verification token is invalid.",
    );
  }

  return createHash(
    "sha256",
  )
    .update(
      EMAIL_VERIFICATION_REPLAY_DOMAIN,
      "utf8",
    )
    .update(
      "\0",
      "utf8",
    )
    .update(
      userId,
      "utf8",
    )
    .update(
      "\0",
      "utf8",
    )
    .update(
      token,
      "utf8",
    )
    .digest(
      "hex",
    );
}

function rejectVerificationReplay():
  never {
  /*
   * Deliberately use the same public-facing class
   * as an invalid credential. The response must not
   * disclose whether a token was previously used.
   */
  throw APIError.from(
    "UNAUTHORIZED",
    {
      code:
        "INVALID_TOKEN",
      message:
        "Invalid token",
    },
  );
}

/*
 * This must be a top-level Better Auth BEFORE hook.
 *
 * Better Auth 1.7.3 performs its already-verified
 * success short-circuit before
 * beforeEmailVerification, so the latter cannot
 * enforce one-time semantics.
 */
export function createEmailVerificationReplayHook(
  database: Pool,
) {
  return createAuthMiddleware(
    async (ctx) => {
      if (
        ctx.path !==
        "/verify-email"
      ) {
        return;
      }

      const request =
        ctx.request;

      if (request === undefined) {
        /*
         * Better Auth owns non-HTTP/programmatic
         * dispatch semantics. Never claim a token
         * when there is no concrete Request.
         */
        return;
      }

      let token:
        string | null;

      try {
        token =
          new URL(
            request.url,
          ).searchParams.get(
            "token",
          );
      } catch {
        /*
         * Let Better Auth own canonical malformed
         * request handling.
         */
        return;
      }

      if (
        token === null ||
        token.length < 1 ||
        token.length >
          MAX_VERIFICATION_TOKEN_LENGTH
      ) {
        return;
      }

      let payload:
        EmailVerificationReplayPayload |
        null;

      try {
        payload =
          await verifyJWT<
            EmailVerificationReplayPayload
          >(
            token,
            ctx.context.secret,
          );
      } catch {
        /*
         * Signature/expiry/malformed-token behavior
         * remains Better Auth-owned.
         */
        return;
      }

      if (payload === null) {
        return;
      }

      const acceptedAt =
        new Date();

      const parsed =
        parseEmailVerificationReplayPayload(
          payload,
          acceptedAt,
        );

      if (parsed === null) {
        /*
         * Let Better Auth preserve its canonical
         * payload-validation failure.
         */
        return;
      }

      const users =
        await database.query<{
          id: string;
          emailVerified: boolean;
        }>(
          `
            SELECT
              "id",
              "emailVerified"
            FROM auth."user"
            WHERE "email" = $1
            LIMIT 2
          `,
          [
            parsed.email,
          ],
        );

      if (
        users.rowCount !== 1 ||
        users.rows.length !== 1
      ) {
        /*
         * Better Auth remains authoritative for
         * USER_NOT_FOUND and abnormal identity
         * handling.
         */
        return;
      }

      const user =
        users.rows[0];

      /*
       * This closes the pre-remediation gap too:
       * a normal verification credential that was
       * already successfully consumed before this
       * guard existed has no ledger row, but its
       * account is already verified and therefore
       * must never receive another success path.
       *
       * Email-change tokens are excluded because
       * their legitimate source account is normally
       * already verified.
       */
      if (
        !parsed.isEmailChange &&
        user.emailVerified === true
      ) {
        rejectVerificationReplay();
      }

      const tokenDigest =
        createEmailVerificationReplayDigest(
          user.id,
          token,
        );

      const claimed =
        await claimEmailVerificationReplayToken(
          database,
          {
            userId:
              user.id,

            tokenDigest,

            acceptedAt,

            expiresAt:
              parsed.expiresAt,
          },
        );

      if (!claimed) {
        rejectVerificationReplay();
      }
    },
  );
}
