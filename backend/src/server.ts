import { createApp } from "./app.js";
import { loadEnv } from "./config/env.js";
import { ApplicationState } from "./runtime/application-state.js";

const env = loadEnv();

const applicationState = new ApplicationState();
const app = createApp(applicationState);

const server = app.listen(env.port, "0.0.0.0", () => {
  applicationState.markReady();

  console.log(
    JSON.stringify({
      event: "server_started",
      service: "delta-backend",
      environment: env.nodeEnv,
      host: "0.0.0.0",
      port: env.port,
      phase: applicationState.getPhase(),
    }),
  );
});

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
    clearTimeout(forcedShutdownTimer);

    if (error) {
      console.error(
        JSON.stringify({
          event: "server_shutdown_failed",
          message: error.message,
        }),
      );

      process.exitCode = 1;
      return;
    }

    console.log(
      JSON.stringify({
        event: "server_shutdown_complete",
      }),
    );
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
