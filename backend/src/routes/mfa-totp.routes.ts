import type {
  Request,
  Response as ExpressResponse,
} from "express";

import {
  Router,
} from "express";

import {
  fromNodeHeaders,
} from "better-auth/node";

import type {
  Pool,
} from "pg";

import type {
  DeltaAuth,
} from "../auth/core.js";

import {
  logMfaSecurityAuditEvent,
} from "../auth/mfa-security-audit.js";

import {
  type CurrentSessionContext,
  resolveCurrentSession,
} from "../auth/session-context.js";

import {
  createTotpReplayDigest,
} from "../auth/totp-replay.js";
import {
  TOTP_REPLACEMENT_TTL_MS,
  createTotpReplacementMaterial,
  isValidTotpCode,
  verifyEncryptedTotpCode,
} from "../auth/totp-replacement.js";

import {
  AppError,
} from "../errors/app-error.js";

import {
  getRequestId,
} from "../middleware/request-context.js";

import {
  createRequireSessionMiddleware,
  getCurrentSessionContext,
} from "../middleware/require-session.js";

import {
  createRequireTrustedOriginMiddleware,
} from "../middleware/require-trusted-origin.js";

import {
  deleteTotpChallengeSession,
  deleteTotpEnrollmentSession,
  disableTotpAndRevokeAllSessions,
  finalizeTotpEnrollmentVerification,
  finalizeTotpLoginChallenge,
  getTotpEnrollmentState,
} from "../storage/totp-replay.js";
import {
  createOrReplaceTotpReplacement,
  finalizeTotpReplacement,
  getActiveTotpEncryptedSecret,
  getTotpReplacement,
  recordTotpReplacementFailure,
} from "../storage/totp-replacement.js";

type MfaTotpDatabase =
  Pick<
    Pool,
    "connect" | "query"
  >;

export type MfaTotpRoutesDependencies =
  Readonly<{
    auth:
      DeltaAuth;

    database:
      MfaTotpDatabase;

    trustedOrigins:
      readonly string[];

  replayPepper:
    string;

  totpEncryptionKey:
    string;

    observeActivity:
      (
        sessionId: string,
        observedAt: Date,
      ) => Promise<unknown>;

    now?:
      () => Date;
  }>;

type UnknownRecord =
  Record<string, unknown>;

type VerificationIdentity =
  Readonly<{
    sessionToken: string;
    userId: string;
  }>;

const TOTP_PATTERN =
  /^[0-9]{6}$/;

const REPLAY_HORIZON_MS =
  5 * 60 * 1000;

function isRecord(
  value: unknown,
): value is UnknownRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function setSensitiveHeaders(
  response: ExpressResponse,
): void {
  response.set(
    "Cache-Control",
    "no-store",
  );

  response.set(
    "Pragma",
    "no-cache",
  );
}

function getBetterAuthSetCookies(
  authResponse: Response,
): readonly string[] {
  const headers =
    authResponse.headers as
      Headers & {
        getSetCookie?:
          () => string[];
      };

  if (
    typeof headers.getSetCookie !==
    "function"
  ) {
    throw new Error(
      "Runtime must support Headers.getSetCookie().",
    );
  }

  return Object.freeze([
    ...headers.getSetCookie(),
  ]);
}

function appendCookies(
  response: ExpressResponse,
  cookies: readonly string[],
): void {
  for (const cookie of cookies) {
    response.append(
      "Set-Cookie",
      cookie,
    );
  }
}

function buildBetterAuthCookieHeader(
  cookies: readonly string[],
): string {
  const pairs:
    string[] =
      [];

  let rotatedSessionCookieCount =
    0;

  for (const cookie of cookies) {
    const separator =
      cookie.indexOf(";");

    const pair =
      (
        separator === -1
          ? cookie
          : cookie.slice(
              0,
              separator,
            )
      ).trim();

    const equals =
      pair.indexOf("=");

    if (equals <= 0) {
      throw new Error(
        "Better Auth returned an invalid Set-Cookie value.",
      );
    }

    const name =
      pair.slice(
        0,
        equals,
      );

    const value =
      pair.slice(
        equals + 1,
      );

    /*
     * Expired/clearing cookies cannot authorize
     * the newly rotated enrollment session.
     */
    if (value.length === 0) {
      continue;
    }

    if (
      name ===
        "delta-auth.session_token" ||
      name ===
        "__Secure-delta-auth.session_token"
    ) {
      rotatedSessionCookieCount +=
        1;
    }

    pairs.push(
      pair,
    );
  }

  if (
    rotatedSessionCookieCount !==
      1
  ) {
    throw new Error(
      "Better Auth did not return exactly one rotated session cookie.",
    );
  }

  return pairs.join(
    "; ",
  );
}

async function resolveRotatedEnrollmentSession(
  auth: DeltaAuth,
  request: Request,
  cookies: readonly string[],
  previous:
    CurrentSessionContext,
): Promise<CurrentSessionContext> {
  /*
   * Better Auth 1.7.3 rotates the durable session
   * during first TOTP verification but its JSON
   * payload still contains the pre-rotation token.
   *
   * The successful Set-Cookie is therefore the
   * canonical credential for resolving the new
   * session. We do not decode or trust the signed
   * cookie ourselves: Better Auth getSession does.
   */
  const resolution =
    await resolveCurrentSession(
      auth,
      {
        ...request.headers,

        cookie:
          buildBetterAuthCookieHeader(
            cookies,
          ),
      },
    );

  if (
    resolution.context === null
  ) {
    throw new Error(
      "Rotated TOTP enrollment session is unavailable.",
    );
  }

  if (
    resolution.context.userId !==
      previous.userId
  ) {
    throw new Error(
      "Rotated TOTP enrollment session user mismatch.",
    );
  }

  if (
    resolution.context.sessionId ===
      previous.sessionId
  ) {
    throw new Error(
      "TOTP enrollment did not rotate the authenticated session.",
    );
  }

  /*
   * A freshly-created session must not need another
   * refresh during this canonical resolution.
   * Failing closed avoids releasing an ambiguous
   * multi-cookie credential sequence.
   */
  if (
    resolution.setCookies.length !==
      0
  ) {
    throw new Error(
      "Rotated TOTP enrollment session unexpectedly refreshed.",
    );
  }

  return resolution.context;
}

function parsePasswordBody(
  body: unknown,
): string {
  if (!isRecord(body)) {
    throw new AppError(
      400,
      "INVALID_MFA_ENROLLMENT_REQUEST",
      "A password is required.",
    );
  }

  const keys =
    Object.keys(body);

  if (
    keys.length !== 1 ||
    keys[0] !== "password"
  ) {
    throw new AppError(
      400,
      "INVALID_MFA_ENROLLMENT_REQUEST",
      "A password is required.",
    );
  }

  const password =
    body.password;

  if (
    typeof password !== "string" ||
    password.length === 0 ||
    password.length > 128
  ) {
    throw new AppError(
      400,
      "INVALID_MFA_ENROLLMENT_REQUEST",
      "A password is required.",
    );
  }

  return password;
}

function parseTotpBody(
  body: unknown,
): string {
  if (!isRecord(body)) {
    throw new AppError(
      400,
      "INVALID_TOTP_REQUEST",
      "A valid TOTP code is required.",
    );
  }

  const keys =
    Object.keys(body);

  if (
    keys.length !== 1 ||
    keys[0] !== "code"
  ) {
    throw new AppError(
      400,
      "INVALID_TOTP_REQUEST",
      "A valid TOTP code is required.",
    );
  }

  const code =
    body.code;

  if (
    typeof code !== "string" ||
    !TOTP_PATTERN.test(code)
  ) {
    throw new AppError(
      400,
      "INVALID_TOTP_REQUEST",
      "A valid TOTP code is required.",
    );
  }

  return code;
}

async function parseTotpEnrollmentUri(
  authResponse: Response,
): Promise<string> {
  const payload: unknown =
    await authResponse.json();

  if (
    !isRecord(payload) ||
    payload.method !== "totp" ||
    typeof payload.totpURI !==
      "string"
  ) {
    throw new Error(
      "Better Auth returned an invalid TOTP enrollment response.",
    );
  }

  let uri: URL;

  try {
    uri =
      new URL(
        payload.totpURI,
      );
  } catch {
    throw new Error(
      "Better Auth returned an invalid TOTP URI.",
    );
  }

  if (
    uri.protocol !== "otpauth:" ||
    uri.hostname !== "totp"
  ) {
    throw new Error(
      "Better Auth returned an invalid TOTP URI.",
    );
  }

  return payload.totpURI;
}

async function parseVerificationIdentity(
  authResponse: Response,
): Promise<VerificationIdentity> {
  const payload: unknown =
    await authResponse.json();

  if (
    !isRecord(payload) ||
    typeof payload.token !== "string" ||
    payload.token.length === 0 ||
    !isRecord(payload.user) ||
    typeof payload.user.id !== "string" ||
    payload.user.id.length === 0
  ) {
    throw new Error(
      "Better Auth returned an invalid TOTP verification response.",
    );
  }

  return Object.freeze({
    sessionToken:
      payload.token,

    userId:
      payload.user.id,
  });
}

function throwEnrollmentFailure(
  authResponse: Response,
): never {
  if (
    authResponse.status === 401
  ) {
    throw new AppError(
      401,
      "AUTHENTICATION_REQUIRED",
      "Authentication is required.",
    );
  }

  if (
    authResponse.status === 429
  ) {
    throw new AppError(
      429,
      "MFA_TEMPORARILY_RATE_LIMITED",
      "MFA enrollment is temporarily unavailable.",
    );
  }

  if (
    authResponse.status === 400 ||
    authResponse.status === 409
  ) {
    throw new AppError(
      400,
      "MFA_ENROLLMENT_REJECTED",
      "TOTP enrollment could not be started.",
    );
  }

  throw new Error(
    `Better Auth TOTP enrollment failed with HTTP ${authResponse.status}.`,
  );
}

function throwVerificationFailure(
  authResponse: Response,
): never {
  if (
    authResponse.status === 429
  ) {
    throw new AppError(
      429,
      "MFA_TEMPORARILY_LOCKED",
      "MFA verification is temporarily unavailable.",
    );
  }

  if (
    authResponse.status === 400 ||
    authResponse.status === 401 ||
    authResponse.status === 409
  ) {
    throw new AppError(
      401,
      "INVALID_TOTP_CODE",
      "The TOTP code could not be verified.",
    );
  }

  throw new Error(
    `Better Auth TOTP verification failed with HTTP ${authResponse.status}.`,
  );
}

async function verifyTotp(
  auth: DeltaAuth,
  request: Request,
  code: string,
): Promise<Response> {
  return auth.api.verifyTOTP({
    headers:
      fromNodeHeaders(
        request.headers,
      ),

    body: {
      code,

      /*
       * Trusted-device MFA bypass is not part of
       * Delta's security model.
       */
      trustDevice:
        false,
    },

    asResponse:
      true,
  });
}


type TotpReplacementVerifyBody = {
  replacementId: string;
  currentCode: string;
  newCode: string;
};

function parseTotpReplacementVerifyBody(
  value: unknown,
): TotpReplacementVerifyBody {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new AppError(
      400,
      "INVALID_REQUEST_BODY",
      "Invalid request body.",
    );
  }

  const body =
    value as Record<string, unknown>;

  if (
    Object.keys(body).length !== 3 ||
    typeof body.replacementId !== "string" ||
    body.replacementId.length < 24 ||
    typeof body.currentCode !== "string" ||
    !isValidTotpCode(body.currentCode) ||
    typeof body.newCode !== "string" ||
    !isValidTotpCode(body.newCode)
  ) {
    throw new AppError(
      400,
      "INVALID_REQUEST_BODY",
      "Invalid request body.",
    );
  }

  return {
    replacementId:
      body.replacementId,

    currentCode:
      body.currentCode,

    newCode:
      body.newCode,
  };
}

export function createMfaTotpRouter(
  dependencies:
    MfaTotpRoutesDependencies,
) {
  const router =
    Router();

  const now =
    dependencies.now ??
    (() => new Date());

  const requireTrustedOrigin =
    createRequireTrustedOriginMiddleware(
      dependencies.trustedOrigins,
    );

  const requireSession =
    createRequireSessionMiddleware({
      auth:
        dependencies.auth,

      observeActivity:
        dependencies.observeActivity,

      now,
    });

  /*
   * Applied before auth/origin gates so error
   * responses from this sensitive surface are
   * also non-cacheable.
   */
  router.use(
    (
      _request,
      response,
      next,
    ) => {
      setSensitiveHeaders(
        response,
      );

      next();
    },
  );

  router.post(
    "/enroll",
    requireTrustedOrigin,
    requireSession,
    async (
      request,
      response,
    ) => {
      const password =
        parsePasswordBody(
          request.body,
        );

      const authResponse =
        await dependencies
          .auth
          .api
          .enableTwoFactor({
            headers:
              fromNodeHeaders(
                request.headers,
              ),

            body: {
              password,
              method:
                "totp",
            },

            asResponse:
              true,
          });

      const cookies =
        getBetterAuthSetCookies(
          authResponse,
        );

      if (!authResponse.ok) {
        appendCookies(
          response,
          cookies,
        );

        logMfaSecurityAuditEvent(
          getRequestId(response),
          "totp_enrollment_started",
          "rejected",
        );

        throwEnrollmentFailure(
          authResponse,
        );
      }

      const totpUri =
        await parseTotpEnrollmentUri(
          authResponse,
        );

      /*
       * Deliberately do not expose Better Auth's
       * backupCodes response field.
       */
      appendCookies(
        response,
        cookies,
      );

      logMfaSecurityAuditEvent(
        getRequestId(response),
        "totp_enrollment_started",
        "success",
      );

      response
        .status(200)
        .json({
          totpUri,
        });
    },
  );

  router.post(
    "/enroll/verify",
    requireTrustedOrigin,
    requireSession,
    async (
      request,
      response,
    ) => {
      const current =
        getCurrentSessionContext(
          response,
        );

      const state =
        await getTotpEnrollmentState(
          dependencies.database,
          current.userId,
        );

      if (state !== "pending") {
        logMfaSecurityAuditEvent(
          getRequestId(response),
          "totp_enrollment_verified",
          "rejected",
        );

        throw new AppError(
          409,
          "TOTP_ENROLLMENT_NOT_PENDING",
          "TOTP enrollment is not pending verification.",
        );
      }

      const code =
        parseTotpBody(
          request.body,
        );

      const authResponse =
        await verifyTotp(
          dependencies.auth,
          request,
          code,
        );

      if (!authResponse.ok) {
        appendCookies(
          response,
          getBetterAuthSetCookies(
            authResponse,
          ),
        );

        logMfaSecurityAuditEvent(
          getRequestId(response),
          "totp_enrollment_verified",
          "rejected",
        );

        throwVerificationFailure(
          authResponse,
        );
      }

      /*
       * Better Auth has activated TOTP and rotated
       * the durable authenticated session.
       *
       * Better Auth 1.7.3 returns the OLD
       * pre-rotation token in its JSON payload.
       * Never use that token for enrollment
       * finalization.
       *
       * Keep the successful Set-Cookie private,
       * resolve it canonically through Better Auth,
       * and expose it only after Delta commits the
       * durable replay claim.
       */
      const verificationCookies =
        getBetterAuthSetCookies(
          authResponse,
        );

      const rotatedSession =
        await resolveRotatedEnrollmentSession(
          dependencies.auth,
          request,
          verificationCookies,
          current,
        );

      const acceptedAt =
        now();

      const replayExpiresAt =
        new Date(
          acceptedAt.getTime() +
          REPLAY_HORIZON_MS,
        );

      const codeDigest =
        createTotpReplayDigest(
          dependencies.replayPepper,
          rotatedSession.userId,
          code,
        );

      let claimed:
        boolean;

      try {
        claimed =
          await finalizeTotpEnrollmentVerification(
            dependencies.database,
            rotatedSession.sessionId,
            rotatedSession.userId,
            codeDigest,
            acceptedAt,
            replayExpiresAt,
          );
      } catch (
        replayError: unknown
      ) {
        try {
          await deleteTotpEnrollmentSession(
            dependencies.database,
            rotatedSession.sessionId,
            rotatedSession.userId,
          );
        } catch {
          console.error(
            JSON.stringify({
              event:
                "auth_mfa_enrollment_session_cleanup_failed",

              requestId:
                getRequestId(
                  response,
                ),
            }),
          );
        }

        throw replayError;
      }

      if (!claimed) {
        logMfaSecurityAuditEvent(
          getRequestId(response),
          "totp_enrollment_verified",
          "replay_rejected",
        );

        throw new AppError(
          401,
          "INVALID_TOTP_CODE",
          "The TOTP code could not be verified.",
        );
      }

      /*
       * The replay winner is now the only surviving
       * session after MFA activation.
       */
      appendCookies(
        response,
        verificationCookies,
      );

      logMfaSecurityAuditEvent(
        getRequestId(response),
        "totp_enrollment_verified",
        "success",
      );

      response
        .status(200)
        .json({
          status:
            true,
        });
    },
  );


  router.post(
    "/replace/start",
    requireTrustedOrigin,
    requireSession,
    async (
      request,
      response,
    ) => {
      const current =
        getCurrentSessionContext(
          response,
        );

      const password =
        parsePasswordBody(
          request.body,
        );

      const state =
        await getTotpEnrollmentState(
          dependencies.database,
          current.userId,
        );

      if (state !== "active") {
        throw new AppError(
          409,
          "TOTP_NOT_ACTIVE",
          "TOTP is not currently active.",
        );
      }

      /*
       * Password proof is delegated to Better Auth.
       * getTOTPURI performs the authoritative password
       * verification without changing the active factor.
       * Delta deliberately discards the returned URI.
       */
      const passwordProof =
        await dependencies
          .auth
          .api
          .getTOTPURI({
            headers:
              fromNodeHeaders(
                request.headers,
              ),

            body: {
              password,
            },

            asResponse:
              true,
          });

      if (!passwordProof.ok) {
        logMfaSecurityAuditEvent(
          getRequestId(response),
          "totp_replacement_started",
          "rejected",
        );

        throw new AppError(
          passwordProof.status === 429
            ? 429
            : 400,

          passwordProof.status === 429
            ? "MFA_TEMPORARILY_RATE_LIMITED"
            : "MFA_REPLACEMENT_REJECTED",

          "TOTP replacement could not be started.",
        );
      }

      const material =
        await createTotpReplacementMaterial(
          dependencies.totpEncryptionKey,
        );

      const createdAt =
        now();

      const expiresAt =
        new Date(
          createdAt.getTime() +
            TOTP_REPLACEMENT_TTL_MS,
        );

      await createOrReplaceTotpReplacement(
        dependencies.database,
        current.userId,
        material.replacementId,
        material.encryptedSecret,
        createdAt,
        expiresAt,
      );

      logMfaSecurityAuditEvent(
        getRequestId(response),
        "totp_replacement_started",
        "success",
      );

      response.status(200).json({
        replacementId:
          material.replacementId,

        totpUri:
          material.totpUri,

        expiresAt:
          expiresAt.toISOString(),
      });
    },
  );

  router.post(
    "/replace/verify",
    requireTrustedOrigin,
    requireSession,
    async (
      request,
      response,
    ) => {
      const current =
        getCurrentSessionContext(
          response,
        );

      const body =
        parseTotpReplacementVerifyBody(
          request.body,
        );

      const observedAt =
        now();

      const pending =
        await getTotpReplacement(
          dependencies.database,
          current.userId,
          body.replacementId,
          observedAt,
        );

      if (pending === null) {
        logMfaSecurityAuditEvent(
          getRequestId(response),
          "totp_replaced",
          "rejected",
        );

        throw new AppError(
          409,
          "TOTP_REPLACEMENT_NOT_PENDING",
          "TOTP replacement is not pending.",
        );
      }

      const activeEncryptedSecret =
        await getActiveTotpEncryptedSecret(
          dependencies.database,
          current.userId,
        );

      if (activeEncryptedSecret === null) {
        throw new AppError(
          409,
          "TOTP_NOT_ACTIVE",
          "TOTP is not currently active.",
        );
      }

      let currentAccepted = false;
      let replacementAccepted = false;

      try {
        currentAccepted =
          await verifyEncryptedTotpCode(
            dependencies.totpEncryptionKey,
            activeEncryptedSecret,
            body.currentCode,
          );

        replacementAccepted =
          await verifyEncryptedTotpCode(
            dependencies.totpEncryptionKey,
            pending.encryptedSecret,
            body.newCode,
          );
      } catch {
        currentAccepted = false;
        replacementAccepted = false;
      }

      if (
        !currentAccepted ||
        !replacementAccepted
      ) {
        await recordTotpReplacementFailure(
          dependencies.database,
          current.userId,
          body.replacementId,
          observedAt,
        );

        logMfaSecurityAuditEvent(
          getRequestId(response),
          "totp_replaced",
          "rejected",
        );

        throw new AppError(
          400,
          "MFA_REPLACEMENT_REJECTED",
          "TOTP replacement could not be verified.",
        );
      }

      /*
       * Reuse the same durable replay digest contract
       * as normal TOTP login verification. Therefore
       * the newly accepted authenticator code cannot
       * immediately be reused in a fresh sign-in.
       */
      const replayDigest =
        createTotpReplayDigest(
          dependencies.replayPepper,
          current.userId,
          body.newCode,
        );

      /*
       * Covers the accepted TOTP/skew horizon while
       * remaining bounded. Expired records are cleaned
       * by the normal replay-claim paths.
       */
      const replayExpiresAt =
        new Date(
          observedAt.getTime() +
            90 * 1000,
        );

      const finalized =
        await finalizeTotpReplacement(
          dependencies.database,
          {
            userId:
              current.userId,

            replacementId:
              body.replacementId,

            currentSessionId:
              current.sessionId,

            expectedEncryptedSecret:
              pending.encryptedSecret,

            replayDigest,

            acceptedAt:
              observedAt,

            replayExpiresAt,
          },
        );

      if (!finalized) {
        logMfaSecurityAuditEvent(
          getRequestId(response),
          "totp_replaced",
          "rejected",
        );

        throw new AppError(
          409,
          "TOTP_REPLACEMENT_CONFLICT",
          "TOTP replacement could not be finalized.",
        );
      }

      logMfaSecurityAuditEvent(
        getRequestId(response),
        "totp_replaced",
        "success",
      );

      response.status(204).end();
    },
  );

  router.post(
    "/disable",
    requireTrustedOrigin,
    requireSession,
    async (
      request,
      response,
    ) => {
      const current =
        getCurrentSessionContext(
          response,
        );

      const password =
        parsePasswordBody(
          request.body,
        );

      const state =
        await getTotpEnrollmentState(
          dependencies.database,
          current.userId,
        );

      if (state !== "active") {
        logMfaSecurityAuditEvent(
          getRequestId(response),
          "totp_disabled",
          "rejected",
        );

        throw new AppError(
          409,
          "TOTP_NOT_ACTIVE",
          "TOTP is not currently active.",
        );
      }

      /*
       * Better Auth performs the authoritative
       * password check and decrypts the existing
       * factor internally. Delta discards the URI.
       *
       * No secret or URI is exposed to this API.
       */
      const passwordProof =
        await dependencies
          .auth
          .api
          .getTOTPURI({
            headers:
              fromNodeHeaders(
                request.headers,
              ),

            body: {
              password,
            },

            asResponse:
              true,
          });

      if (!passwordProof.ok) {
        logMfaSecurityAuditEvent(
          getRequestId(response),
          "totp_disabled",
          "rejected",
        );

        throw new AppError(
          passwordProof.status === 429
            ? 429
            : 400,
          passwordProof.status === 429
            ? "MFA_TEMPORARILY_RATE_LIMITED"
            : "MFA_DISABLE_REJECTED",
          "TOTP could not be disabled.",
        );
      }

      /*
       * The downgrade itself is one Delta-owned
       * database transaction:
       *
       *   - disable user MFA flag
       *   - delete encrypted factor
       *   - clear replay ledger
       *   - revoke every durable session
       *
       * No replacement session is minted.
       */
      const disabled =
        await disableTotpAndRevokeAllSessions(
          dependencies.database,
          current.userId,
          now(),
        );

      if (!disabled) {
        logMfaSecurityAuditEvent(
          getRequestId(response),
          "totp_disabled",
          "rejected",
        );

        throw new AppError(
          409,
          "TOTP_NOT_ACTIVE",
          "TOTP is not currently active.",
        );
      }

      /*
       * All durable sessions are already gone.
       * Better Auth signOut is used only for its
       * canonical browser-cookie expiration.
       */
      const signOutResponse =
        await dependencies
          .auth
          .api
          .signOut({
            headers:
              fromNodeHeaders(
                request.headers,
              ),

            body: {
              disableRedirect:
                true,
            },

            asResponse:
              true,
          });

      if (!signOutResponse.ok) {
        throw new Error(
          `Better Auth cookie cleanup failed with HTTP ${signOutResponse.status}.`,
        );
      }

      appendCookies(
        response,
        getBetterAuthSetCookies(
          signOutResponse,
        ),
      );

      logMfaSecurityAuditEvent(
        getRequestId(response),
        "totp_disabled",
        "success",
      );

      response
        .status(204)
        .end();
    },
  );

  router.post(
    "/challenge/verify",
    requireTrustedOrigin,
    async (
      request,
      response,
    ) => {
      /*
       * A credential-login 2FA challenge must not
       * coexist with an authenticated session.
       */
      const existing =
        await resolveCurrentSession(
          dependencies.auth,
          request.headers,
        );

      appendCookies(
        response,
        existing.setCookies,
      );

      if (
        existing.context !== null
      ) {
        logMfaSecurityAuditEvent(
          getRequestId(response),
          "totp_login_challenge_verified",
          "rejected",
        );

        throw new AppError(
          409,
          "MFA_CHALLENGE_REQUIRES_UNAUTHENTICATED_STATE",
          "The MFA login challenge is not valid for an authenticated session.",
        );
      }

      const code =
        parseTotpBody(
          request.body,
        );

      const authResponse =
        await verifyTotp(
          dependencies.auth,
          request,
          code,
        );

      if (!authResponse.ok) {
        appendCookies(
          response,
          getBetterAuthSetCookies(
            authResponse,
          ),
        );

        logMfaSecurityAuditEvent(
          getRequestId(response),
          "totp_login_challenge_verified",
          "rejected",
        );

        throwVerificationFailure(
          authResponse,
        );
      }

      /*
       * Important:
       *
       * Better Auth has now consumed the challenge
       * and minted a session, but Delta has NOT
       * forwarded its successful Set-Cookie yet.
       */
      const identity =
        await parseVerificationIdentity(
          authResponse,
        );

      const acceptedAt =
        now();

      const replayExpiresAt =
        new Date(
          acceptedAt.getTime() +
          REPLAY_HORIZON_MS,
        );

      const codeDigest =
        createTotpReplayDigest(
          dependencies.replayPepper,
          identity.userId,
          code,
        );

      let claimed:
        boolean;

      try {
        claimed =
          await finalizeTotpLoginChallenge(
            dependencies.database,
            identity.sessionToken,
            identity.userId,
            codeDigest,
            acceptedAt,
            replayExpiresAt,
          );
      } catch (
        replayError: unknown
      ) {
        /*
         * No successful Better Auth cookie has been
         * exposed. Try to remove the newly-minted
         * session as a second fail-closed boundary.
         */
        try {
          await deleteTotpChallengeSession(
            dependencies.database,
            identity.sessionToken,
            identity.userId,
          );
        } catch {
          console.error(
            JSON.stringify({
              event:
                "auth_mfa_challenge_session_cleanup_failed",

              requestId:
                getRequestId(
                  response,
                ),
            }),
          );
        }

        throw replayError;
      }

      if (!claimed) {
        /*
         * finalizeTotpLoginChallenge already
         * deleted the replay-loser session in the
         * same transaction.
         */
        logMfaSecurityAuditEvent(
          getRequestId(response),
          "totp_login_challenge_verified",
          "replay_rejected",
        );

        throw new AppError(
          401,
          "INVALID_TOTP_CODE",
          "The TOTP code could not be verified.",
        );
      }

      /*
       * Only the replay winner is allowed to
       * receive Better Auth's session cookie.
       */
      appendCookies(
        response,
        getBetterAuthSetCookies(
          authResponse,
        ),
      );

      logMfaSecurityAuditEvent(
        getRequestId(response),
        "totp_login_challenge_verified",
        "success",
      );

      /*
       * Never expose Better Auth's bearer token or
       * user object in Delta's public MFA response.
       */
      response
        .status(200)
        .json({
          status:
            true,
        });
    },
  );

  return router;
}
