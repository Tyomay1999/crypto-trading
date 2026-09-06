import type {
  NextFunction,
  Request,
  RequestHandler,
  Response,
} from "express";

import type {
  DeltaAuth,
} from "../auth/core.js";

import {
  type CurrentSessionContext,
  resolveCurrentSession,
} from "../auth/session-context.js";

import {
  AppError,
} from "../errors/app-error.js";

import {
  getRequestId,
} from "./request-context.js";

const CURRENT_SESSION_CONTEXT:
  unique symbol =
    Symbol(
      "delta.current-session-context",
    );

type SessionBoundResponse =
  Response & {
    [CURRENT_SESSION_CONTEXT]?:
      CurrentSessionContext;
  };

export type RequireSessionDependencies = {
  auth: DeltaAuth;

  observeActivity:
    (
      sessionId: string,
      observedAt: Date,
    ) => Promise<unknown>;

  now?: () => Date;
};

function appendBetterAuthCookies(
  response: Response,
  cookies:
    readonly string[],
): void {
  for (const cookie of cookies) {
    response.append(
      "Set-Cookie",
      cookie,
    );
  }
}

export function getCurrentSessionContext(
  response: Response,
): CurrentSessionContext {
  const context =
    (
      response as
        SessionBoundResponse
    )[CURRENT_SESSION_CONTEXT];

  if (context === undefined) {
    throw new Error(
      "Authenticated session context is unavailable.",
    );
  }

  return context;
}

export function createRequireSessionMiddleware(
  dependencies:
    RequireSessionDependencies,
): RequestHandler {
  const now =
    dependencies.now ??
    (() => new Date());

  return async (
    request: Request,
    response: Response,
    next: NextFunction,
  ): Promise<void> => {
    let resolution:
      Awaited<
        ReturnType<
          typeof resolveCurrentSession
        >
      >;

    try {
      resolution =
        await resolveCurrentSession(
          dependencies.auth,
          request.headers,
        );
    } catch (error) {
      next(error);
      return;
    }

    /*
     * Propagate Better Auth session refresh or
     * stale-cookie deletion before continuing.
     */
    appendBetterAuthCookies(
      response,
      resolution.setCookies,
    );

    const currentSession =
      resolution.context;

    if (currentSession === null) {
      next(
        new AppError(
          401,
          "AUTHENTICATION_REQUIRED",
          "Authentication is required.",
        ),
      );

      return;
    }

    (
      response as
        SessionBoundResponse
    )[CURRENT_SESSION_CONTEXT] =
      currentSession;

    /*
     * Activity metadata is auxiliary.
     *
     * A transient activity-storage failure must
     * not invalidate an otherwise valid
     * Better Auth session.
     */
    try {
      await dependencies
        .observeActivity(
          currentSession.sessionId,
          now(),
        );
    } catch {
      console.error(
        JSON.stringify({
          event:
            "auth_session_activity_touch_failed",
          requestId:
            getRequestId(
              response,
            ),
        }),
      );
    }

    next();
  };
}
