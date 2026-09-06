import { createApp } from "./app.js";
import { loadEnv } from "./config/env.js";
import { ApplicationState } from "./runtime/application-state.js";
import {
  assertDatabaseReady,
  createDatabasePool,
  isDatabaseReady,
} from "./storage/database.js";
import {
  runMigrations,
} from "./storage/migrations.js";

const env = loadEnv();

const applicationState = new ApplicationState();

const databasePool =
  createDatabasePool(env);

const app = createApp(
  applicationState,
  {
    databaseReady: () =>
      isDatabaseReady(databasePool),
  },
);

const server = app.listen(
  env.port,
  "0.0.0.0",
  async () => {
    try {
      await assertDatabaseReady(databasePool);
      await runMigrations(databasePool);

      applicationState.markReady();

      console.log(
        JSON.stringify({
          event: "server_started",
          service: "delta-backend",
          environment: env.nodeEnv,
          host: "0.0.0.0",
          port: env.port,
          phase: applicationState.getPhase(),
          database: "ready",
        }),
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "server_startup_failed",
          message:
            error instanceof Error
              ? error.message
              : "Unknown startup error",
        }),
      );

      process.exitCode = 1;

      server.close(() => {
        void databasePool.end();
      });
    }
  },
);

server.on("error", (error) => {
  console.error(
    JSON.stringify({
      event: "server_error",
      service: "delta-backend",
      message: error.message,
    }),
  );

  process.exitCode = 1;
});

let shuttingDown = false;

function shutdown(signal: string): void {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  applicationState.markShuttingDown();

  console.log(
    JSON.stringify({
      event: "server_shutdown_started",
      signal,
      phase: applicationState.getPhase(),
      graceMs: env.shutdownGraceMs,
    }),
  );

  const forcedShutdownTimer = setTimeout(() => {
    console.error(
      JSON.stringify({
        event: "server_shutdown_timeout",
        graceMs: env.shutdownGraceMs,
      }),
    );

    server.closeAllConnections();
    process.exitCode = 1;
  }, env.shutdownGraceMs);

  forcedShutdownTimer.unref();

  server.close((error) => {
    if (error) {
      clearTimeout(forcedShutdownTimer);

      console.error(
        JSON.stringify({
          event: "server_shutdown_failed",
          message: error.message,
        }),
      );

      process.exitCode = 1;
      return;
    }

    void databasePool
      .end()
      .then(() => {
        clearTimeout(forcedShutdownTimer);

        console.log(
          JSON.stringify({
            event: "server_shutdown_complete",
          }),
        );
      })
      .catch((databaseError: unknown) => {
        clearTimeout(forcedShutdownTimer);

        console.error(
          JSON.stringify({
            event: "database_shutdown_failed",
            message:
              databaseError instanceof Error
                ? databaseError.message
                : "Unknown database shutdown error",
          }),
        );

        process.exitCode = 1;
      });
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
