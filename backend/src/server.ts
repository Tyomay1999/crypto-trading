import { once } from "node:events";
import type {
  Server,
} from "node:http";

import { createApp } from "./app.js";
import {
  loadAuthEnv,
} from "./auth/config.js";
import {
  createDeltaAuth,
} from "./auth/core.js";
import {
  SessionActivityHeartbeat,
} from "./auth/session-activity-heartbeat.js";
import {
  createAuthDatabasePool,
} from "./auth/database.js";
import {
  createAuthEmailDelivery,
  loadAuthEmailEnv,
} from "./auth/email-delivery.js";
import { loadEnv } from "./config/env.js";
import {
  ApplicationState,
} from "./runtime/application-state.js";
import {
  assertDatabaseReady,
  createDatabasePool,
  isDatabaseReady,
} from "./storage/database.js";
import {
  runMigrations,
} from "./storage/migrations.js";
import {
  touchSessionActivity,
} from "./storage/session-activity.js";

const env = loadEnv();
const authEnv = loadAuthEnv();

const authEmailEnv =
  loadAuthEmailEnv(
    authEnv.baseUrl,
  );

const authEmailDelivery =
  createAuthEmailDelivery(
    authEmailEnv,
  );

const applicationState =
  new ApplicationState();

const databasePool =
  createDatabasePool(env);

const sessionActivityHeartbeat =
  new SessionActivityHeartbeat(
    (
      sessionId,
      observedAt,
    ) =>
      touchSessionActivity(
        databasePool,
        sessionId,
        observedAt,
      ),
  );

const authDatabasePool =
  createAuthDatabasePool(env);

let server: Server | undefined;
let shuttingDown = false;

let closeResourcesPromise:
  Promise<void> | undefined;

function closeDatabaseResources():
  Promise<void> {
  if (
    closeResourcesPromise !== undefined
  ) {
    return closeResourcesPromise;
  }

  closeResourcesPromise =
    (async () => {
      const results =
        await Promise.allSettled([
          authDatabasePool.end(),
          databasePool.end(),
        ]);

      const failures =
        results.filter(
          (
            result,
          ): result is PromiseRejectedResult =>
            result.status === "rejected",
        );

      if (failures.length > 0) {
        throw new Error(
          failures
            .map((failure) =>
              failure.reason instanceof Error
                ? failure.reason.message
                : String(
                    failure.reason,
                  ),
            )
            .join("; "),
        );
      }
    })();

  return closeResourcesPromise;
}

async function closeServerIfRunning():
  Promise<void> {
  if (server === undefined) {
    return;
  }

  await new Promise<void>(
    (resolve) => {
      server?.close(() => {
        resolve();
      });
    },
  );
}

async function startup(): Promise<void> {
  try {
    /*
     * The listening socket is intentionally
     * created only after storage and auth
     * prerequisites have been accepted.
     */
    await assertDatabaseReady(
      databasePool,
    );

    await runMigrations(
      databasePool,
    );

    await assertDatabaseReady(
      authDatabasePool,
    );

    const auth = createDeltaAuth(
      authDatabasePool,
      authEnv,
      authEmailDelivery,
    );

    const app = createApp(
      applicationState,
      {
        databaseReady: () =>
          isDatabaseReady(
            databasePool,
          ),
        authDatabaseReady: () =>
          isDatabaseReady(
            authDatabasePool,
          ),
      },
      auth,
      {
        database:
          databasePool,

        trustedOrigins:
          authEnv.trustedOrigins,

        observeActivity:
          (
            sessionId,
            observedAt,
          ) =>
            sessionActivityHeartbeat
              .observe(
                sessionId,
                observedAt,
              ),
      },
      {
        database:
          databasePool,

        trustedOrigins:
          authEnv.trustedOrigins,

        /*
         * totp-replay.ts derives a dedicated,
         * domain-separated replay HMAC sub-key
         * from the existing Better Auth secret.
         */
        replayPepper:
          authEnv.replayPepper,

        /*
         * Public Better Auth crypto helpers use the
         * same configured secret as the active TOTP
         * factor encryption contract.
         */
        totpEncryptionKey:
          authEnv.secret,

        observeActivity:
          (
            sessionId,
            observedAt,
          ) =>
            sessionActivityHeartbeat
              .observe(
                sessionId,
                observedAt,
              ),
      },
      {
        database:
          databasePool,

        trustedOrigins:
          authEnv.trustedOrigins,

        recoveryPepper:
          authEnv.recoveryPepper,
      },
    );

    server = app.listen(
      env.port,
      "0.0.0.0",
    );

    server.on(
      "error",
      (error) => {
        console.error(
          JSON.stringify({
            event: "server_error",
            service:
              "delta-backend",
            message:
              error.message,
          }),
        );

        process.exitCode = 1;
      },
    );

    await once(
      server,
      "listening",
    );

    if (shuttingDown) {
      await closeServerIfRunning();
      await closeDatabaseResources();
      return;
    }

    applicationState.markReady();

    console.log(
      JSON.stringify({
        event: "server_started",
        service: "delta-backend",
        environment: env.nodeEnv,
        host: "0.0.0.0",
        port: env.port,
        phase:
          applicationState.getPhase(),
        database: "ready",
        authentication: "ready",
      }),
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        event:
          "server_startup_failed",
        message:
          error instanceof Error
            ? error.message
            : "Unknown startup error",
      }),
    );

    process.exitCode = 1;

    await closeServerIfRunning();

    try {
      await closeDatabaseResources();
    } catch (
      shutdownError: unknown
    ) {
      console.error(
        JSON.stringify({
          event:
            "database_shutdown_failed",
          message:
            shutdownError instanceof Error
              ? shutdownError.message
              : "Unknown database shutdown error",
        }),
      );
    }
  }
}

function shutdown(signal: string): void {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  applicationState
    .markShuttingDown();

  console.log(
    JSON.stringify({
      event:
        "server_shutdown_started",
      signal,
      phase:
        applicationState.getPhase(),
      graceMs:
        env.shutdownGraceMs,
    }),
  );

  const forcedShutdownTimer =
    setTimeout(() => {
      console.error(
        JSON.stringify({
          event:
            "server_shutdown_timeout",
          graceMs:
            env.shutdownGraceMs,
        }),
      );

      server?.closeAllConnections();

      process.exitCode = 1;

      void closeDatabaseResources();
    }, env.shutdownGraceMs);

  forcedShutdownTimer.unref();

  const finishShutdown =
    async (
      serverError?: Error,
    ): Promise<void> => {
      let failed =
        serverError !== undefined;

      if (
        serverError !== undefined
      ) {
        console.error(
          JSON.stringify({
            event:
              "server_shutdown_failed",
            message:
              serverError.message,
          }),
        );
      }

      try {
        await closeDatabaseResources();
      } catch (
        databaseError: unknown
      ) {
        failed = true;

        console.error(
          JSON.stringify({
            event:
              "database_shutdown_failed",
            message:
              databaseError instanceof Error
                ? databaseError.message
                : "Unknown database shutdown error",
          }),
        );
      }

      clearTimeout(
        forcedShutdownTimer,
      );

      if (failed) {
        process.exitCode = 1;
        return;
      }

      console.log(
        JSON.stringify({
          event:
            "server_shutdown_complete",
        }),
      );
    };

  if (server === undefined) {
    void finishShutdown();
    return;
  }

  server.close((error) => {
    void finishShutdown(
      error ?? undefined,
    );
  });
}

process.on(
  "SIGTERM",
  () => shutdown("SIGTERM"),
);

process.on(
  "SIGINT",
  () => shutdown("SIGINT"),
);

void startup();
