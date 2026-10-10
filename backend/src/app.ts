import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { verifyPassword } from "better-auth/crypto";
import { toNodeHandler } from "better-auth/node";

import {
  loadAuthEnv,
} from "./auth/config.js";
import type { DeltaAuth } from "./auth/core.js";
import {
  createProductionPasskeyAdministrationService,
} from "./auth/passkey-public-plugin.js";
import {
  errorHandlerMiddleware,
} from "./middleware/error-handler.js";
import {
  PASSKEY_JSON_BODY_LIMIT,
  passkeyErrorHandler,
  passkeySensitiveHeaders,
} from "./middleware/passkey-errors.js";
import {
  notFoundMiddleware,
} from "./middleware/not-found.js";
import {
  RECOVERY_PREFIX,
  recoveryErrorHandler,
  recoverySensitiveHeaders,
} from "./middleware/recovery-errors.js";
import {
  requestContextMiddleware,
} from "./middleware/request-context.js";
import {
  createRequireSessionMiddleware,
} from "./middleware/require-session.js";
import {
  createRequireTrustedOriginMiddleware,
} from "./middleware/require-trusted-origin.js";
import {
  createHealthRouter,
  type HealthDependencies,
} from "./routes/health.routes.js";
import {
  createSessionRouter,
  type SessionRoutesDependencies,
} from "./routes/session.routes.js";
import {
  createMfaTotpRouter,
  type MfaTotpRoutesDependencies,
} from "./routes/mfa-totp.routes.js";
import {
  createRecoveryRouter,
  type RecoveryRoutesDependencies,
} from "./routes/mfa-recovery-codes.routes.js";
import {
  PASSKEY_PUBLIC_PREFIX,
  createPasskeyAuthenticationRouteOperations,
  createPasskeyEnrollmentRouteOperations,
  createPasskeyManagementRouteOperations,
  createPasskeyRouter,
  type PasskeyAuthenticationAuthBridge,
  type PasskeyEnrollmentAuthBridge,
} from "./routes/passkey.routes.js";
import type {
  ApplicationState,
} from "./runtime/application-state.js";

type SessionManagementAppDependencies =
  Omit<
    SessionRoutesDependencies,
    "auth" | "database"
  > &
  Readonly<{
    database: Parameters<
      typeof createProductionPasskeyAdministrationService
    >[0];
  }>;

type MfaTotpAppDependencies =
  Omit<
    MfaTotpRoutesDependencies,
    "auth"
  >;

export function createApp(
  applicationState: ApplicationState,
  healthDependencies: HealthDependencies,
  auth?: DeltaAuth,
  sessionManagementDependencies?:
    SessionManagementAppDependencies,
  mfaTotpDependencies?:
    MfaTotpAppDependencies,
  recoveryDependencies?: Omit<
    RecoveryRoutesDependencies,
    "auth"
  >,
) {
  const app = express();

  app.disable("x-powered-by");

  /*
   * Request context does not consume the body,
   * therefore it can safely precede Better Auth.
   */
  app.use(RECOVERY_PREFIX, recoverySensitiveHeaders);
  app.use(requestContextMiddleware);

  /*
   * Better Auth MUST be mounted before
   * express.json(). Express 5 uses the named
   * catch-all parameter syntax "*splat".
   */
  if (auth !== undefined) {
    app.all(
      "/api/auth/*splat",
      toNodeHandler(auth),
    );
  }

  /*
   * Public passkey requests need their security headers and
   * parser error normalization before any parser consumes the
   * request stream. The normal global parser remains unchanged
   * for every other Delta route.
   */
  app.use(
    PASSKEY_PUBLIC_PREFIX,
    passkeySensitiveHeaders,
    express.json({
      limit: PASSKEY_JSON_BODY_LIMIT,
    }),
    (
      _request: Request,
      response: Response,
      next: NextFunction,
    ) => {
      response.locals.passkeyJsonParsed =
        true;
      next();
    },
    passkeyErrorHandler,
  );

  /*
   * All normal Delta JSON routes are parsed
   * only after the Better Auth request stream
   * has had the opportunity to consume it.
   */
  app.use(RECOVERY_PREFIX, express.json({ limit: "2kb" }));
  const normalDeltaJsonParser =
    express.json();
  app.use(
    (request, response, next) => {
      if (
        response.locals
          .passkeyJsonParsed === true
      ) {
        next();
        return;
      }
      normalDeltaJsonParser(
        request,
        response,
        next,
      );
    },
  );

  if (recoveryDependencies) {
    if (!auth) {
      throw new Error(
        "Recovery codes require Better Auth.",
      );
    }

    app.use(
      RECOVERY_PREFIX,
      createRecoveryRouter({
        ...recoveryDependencies,
        auth,
      }),
    );
  }

  if (
    sessionManagementDependencies !==
    undefined
  ) {
    if (auth === undefined) {
      throw new Error(
        "Session management requires Better Auth.",
      );
    }

    app.use(
      "/api/v1/auth/sessions",
      createSessionRouter({
        ...sessionManagementDependencies,
        auth,
      }),
    );
  }
  if (
    mfaTotpDependencies !==
    undefined
  ) {
    if (auth === undefined) {
      throw new Error(
        "TOTP MFA requires Better Auth.",
      );
    }

    app.use(
      "/api/v1/auth/mfa/totp",
      createMfaTotpRouter({
        ...mfaTotpDependencies,
        auth,
      }),
    );
  }

  if (
    auth !== undefined &&
    sessionManagementDependencies !== undefined &&
    mfaTotpDependencies !== undefined &&
    recoveryDependencies !== undefined
  ) {
    const authEnvironment =
      loadAuthEnv();
    const administrationService =
      createProductionPasskeyAdministrationService(
        sessionManagementDependencies.database,
        authEnvironment,
        verifyPassword,
      );
    const managementOperations =
      createPasskeyManagementRouteOperations({
        async list(input) {
          return (await administrationService)
            .list(input);
        },
        async rename(input) {
          return (await administrationService)
            .rename(input);
        },
        async remove(input) {
          return (await administrationService)
            .remove(input);
        },
      });

    app.use(
      PASSKEY_PUBLIC_PREFIX,
      createPasskeyRouter({
        operations: Object.freeze({
          ...createPasskeyEnrollmentRouteOperations(
            auth as unknown as
              PasskeyEnrollmentAuthBridge,
          ),
          ...createPasskeyAuthenticationRouteOperations(
            auth as unknown as
              PasskeyAuthenticationAuthBridge,
          ),
          ...managementOperations,
        }),
        secureCookies:
          authEnvironment.useSecureCookies,
        managementSecurity: {
          requireSession:
            createRequireSessionMiddleware({
              auth,
              observeActivity:
                sessionManagementDependencies
                  .observeActivity,
            }),
          requireTrustedOrigin:
            createRequireTrustedOriginMiddleware(
              authEnvironment.trustedOrigins,
            ),
        },
      }),
    );
  }

  const healthRouter =
    createHealthRouter(
      applicationState,
      healthDependencies,
    );

  app.use(
    "/health",
    healthRouter,
  );

  app.use(
    "/api/v1/health",
    healthRouter,
  );

  app.get("/", (_request, response) => {
    response.status(200).json({
      service: "delta-backend",
      version: "v1",
      message: "Delta Backend API",
    });
  });

  app.use(notFoundMiddleware);
  app.use(RECOVERY_PREFIX, recoveryErrorHandler);
  app.use(errorHandlerMiddleware);

  return app;
}
