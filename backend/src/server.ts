import { createApp } from "./app.js";
import { env } from "./config/env.js";

const app = createApp();

const server = app.listen(env.port, "0.0.0.0", () => {
  console.log(
    JSON.stringify({
      event: "server_started",
      service: "delta-backend",
      environment: env.nodeEnv,
      host: "0.0.0.0",
      port: env.port,
    }),
  );
});

let shuttingDown = false;

function shutdown(signal: string): void {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  console.log(
    JSON.stringify({
      event: "server_shutdown_started",
      signal,
    }),
  );

  server.close((error) => {
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
