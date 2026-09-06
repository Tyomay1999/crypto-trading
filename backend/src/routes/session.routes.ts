import {
  logSessionSecurityAuditEvent,
} from "../auth/session-security-audit.js";

import {
  getRequestId,
} from "../middleware/request-context.js";

import {
  Router,
} from "express";

import type {
  Response as ExpressResponse,
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
  projectManagedSessions,
} from "../auth/session-metadata.js";

import {
  AppError,
} from "../errors/app-error.js";

import {
  createRequireSessionMiddleware,
  getCurrentSessionContext,
} from "../middleware/require-session.js";

import {
  createRequireTrustedOriginMiddleware,
} from "../middleware/require-trusted-origin.js";

import {
  getOwnedActiveSessionCredential,
} from "../storage/session-control.js";

import {
  listActiveSessions,
} from "../storage/session-inventory.js";

type SessionRoutesDatabase =
  Pick<Pool, "query">;

export type SessionRoutesDependencies =
  Readonly<{
    auth: DeltaAuth;

    database:
      SessionRoutesDatabase;

    trustedOrigins:
      readonly string[];

    observeActivity:
      (
        sessionId: string,
        observedAt: Date,
      ) => Promise<unknown>;

    now?: () => Date;
  }>;

type UnknownRecord =
  Record<string, unknown>;

function isRecord(
  value: unknown,
): value is UnknownRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function parseSessionId(
  body: unknown,
): string {
  if (!isRecord(body)) {
    throw new AppError(
      400,
      "INVALID_SESSION_ID",
      "A valid sessionId is required.",
    );
  }

  const keys =
    Object.keys(body);

  if (
    keys.length !== 1 ||
    keys[0] !== "sessionId"
  ) {
    throw new AppError(
      400,
      "INVALID_SESSION_ID",
      "A valid sessionId is required.",
    );
  }

  const sessionId =
    body.sessionId;

  if (
    typeof sessionId !== "string" ||
    sessionId.length === 0 ||
    sessionId.length > 255 ||
    sessionId !==
      sessionId.trim()
  ) {
    throw new AppError(
      400,
      "INVALID_SESSION_ID",
      "A valid sessionId is required.",
    );
  }

  return sessionId;
}

function appendBetterAuthCookies(
  response: ExpressResponse,
  authResponse: Response,
): void {
  const headers =
    authResponse.headers as
      Headers & {
        getSetCookie?: () => string[];
      };

  if (
    typeof headers.getSetCookie !==
    "function"
  ) {
    throw new Error(
      "Runtime must support Headers.getSetCookie().",
    );
  }

  for (
    const cookie of
    headers.getSetCookie()
  ) {
    response.append(
      "Set-Cookie",
      cookie,
    );
  }
}

async function requireSuccessfulBetterAuthMutation(
  authResponse:
    Response,
  response:
    ExpressResponse,
  operation:
    string,
): Promise<void> {
  appendBetterAuthCookies(
    response,
    authResponse,
  );

  if (authResponse.ok) {
    return;
  }

  if (
    authResponse.status === 401
  ) {
    throw new AppError(
      401,
      "AUTHENTICATION_REQUIRED",
      "Authentication is required.",
    );
  }

  throw new Error(
    `${operation} failed with HTTP ${authResponse.status}.`,
  );
}

export function createSessionRouter(
  dependencies:
    SessionRoutesDependencies,
) {
  const router =
    Router();

  const now =
    dependencies.now ??
    (() => new Date());

  const requireSession =
    createRequireSessionMiddleware({
      auth:
        dependencies.auth,

      observeActivity:
        dependencies
          .observeActivity,

      now,
    });

  const requireTrustedOrigin =
    createRequireTrustedOriginMiddleware(
      dependencies.trustedOrigins,
    );

  router.get(
    "/",
    requireSession,
    async (
      _request,
      response,
    ) => {
      const current =
        getCurrentSessionContext(
          response,
        );

      const sessions =
        await listActiveSessions(
          dependencies.database,
          current.userId,
          now(),
        );

      const views =
        projectManagedSessions(
          sessions,
          current.sessionId,
        );

      /*
       * requireSession just validated the current
       * session. If it disappeared before the
       * inventory query, fail closed rather than
       * returning a misleading "no current device"
       * representation.
       */
      const currentSessionCount =
        views.filter(
          (session) =>
            session.current,
        ).length;

      if (
        currentSessionCount !== 1
      ) {
        throw new AppError(
          401,
          "AUTHENTICATION_REQUIRED",
          "Authentication is required.",
        );
      }

      response.set(
        "Cache-Control",
        "no-store",
      );

      response.set(
        "Pragma",
        "no-cache",
      );

      response
        .status(200)
        .json({
          sessions:
            views,
        });
    },
  );

  router.post(
    "/revoke",
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

      const targetSessionId =
        parseSessionId(
          request.body,
        );

      if (
        targetSessionId ===
        current.sessionId
      ) {
        throw new AppError(
          409,
          "CURRENT_SESSION_REQUIRES_LOGOUT",
          "The current session must be ended through logout.",
        );
      }

      const credential =
        await getOwnedActiveSessionCredential(
          dependencies.database,
          current.userId,
          targetSessionId,
          now(),
        );

      /*
       * Missing session and another user's session
       * intentionally share the same response.
       */
      if (
        credential === null
      ) {
        throw new AppError(
          404,
          "SESSION_NOT_FOUND",
          "The requested session was not found.",
        );
      }

      const authResponse =
        await dependencies
          .auth
          .api
          .revokeSession({
            headers:
              fromNodeHeaders(
                request.headers,
              ),

            body: {
              token:
                credential.token,
            },

            asResponse:
              true,
          });

      await requireSuccessfulBetterAuthMutation(
        authResponse,
        response,
        "Better Auth revokeSession",
      );

      logSessionSecurityAuditEvent(
        getRequestId(
          response,
        ),
        "revoke_other_session",
      );

      response
        .status(204)
        .end();
    },
  );

  router.post(
    "/logout-current",
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

      /*
       * Resolve the current bearer credential
       * server-side so deletion can be enforced
       * through revokeSession before cookie clear.
       */
      const credential =
        await getOwnedActiveSessionCredential(
          dependencies.database,
          current.userId,
          current.sessionId,
          now(),
        );

      if (
        credential === null
      ) {
        throw new AppError(
          401,
          "AUTHENTICATION_REQUIRED",
          "Authentication is required.",
        );
      }

      const revokeResponse =
        await dependencies
          .auth
          .api
          .revokeSession({
            headers:
              fromNodeHeaders(
                request.headers,
              ),

            body: {
              token:
                credential.token,
            },

            asResponse:
              true,
          });

      await requireSuccessfulBetterAuthMutation(
        revokeResponse,
        response,
        "Better Auth revokeSession current",
      );

      /*
       * Audit the durable security mutation before
       * browser-cookie cleanup. If signOut were to
       * fail, the revoked server-side session must
       * still have an audit record.
       */
      logSessionSecurityAuditEvent(
        getRequestId(
          response,
        ),
        "logout_current",
      );

      /*
       * The durable session is already gone.
       * signOut is now used to clear the browser
       * cookie using Better Auth's own semantics.
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

      await requireSuccessfulBetterAuthMutation(
        signOutResponse,
        response,
        "Better Auth signOut",
      );

      response
        .status(204)
        .end();
    },
  );

  router.post(
    "/logout-everywhere",
    requireTrustedOrigin,
    requireSession,
    async (
      request,
      response,
    ) => {
      /*
       * revokeSessions is authoritative and removes
       * every durable session for this user,
       * including the current one.
       */
      const revokeResponse =
        await dependencies
          .auth
          .api
          .revokeSessions({
            headers:
              fromNodeHeaders(
                request.headers,
              ),

            asResponse:
              true,
          });

      await requireSuccessfulBetterAuthMutation(
        revokeResponse,
        response,
        "Better Auth revokeSessions",
      );

      /*
       * Audit the durable all-session revocation
       * before current-browser cookie cleanup.
       */
      logSessionSecurityAuditEvent(
        getRequestId(
          response,
        ),
        "logout_everywhere",
      );

      /*
       * Clear the current browser's cookie after
       * durable all-session deletion succeeds.
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

      await requireSuccessfulBetterAuthMutation(
        signOutResponse,
        response,
        "Better Auth signOut everywhere",
      );

      response
        .status(204)
        .end();
    },
  );

  return router;
}
