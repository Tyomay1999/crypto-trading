import { createDevSimulatorRuntime } from "./runtime.js";
import { loadDevSimulatorConfig } from "./config.js";
import {
  createDevControlServer,
  listenDevControlServer,
} from "./server.js";

async function main(): Promise<void> {
  const config = loadDevSimulatorConfig(process.env);
  const runtime = createDevSimulatorRuntime(process.env);
  const server = createDevControlServer(runtime.controller, {
    host: config.host,
    port: config.port,
  });

  const address = await listenDevControlServer(server, {
    host: config.host,
    port: config.port,
  });

  process.stdout.write(
    `DELTA DEV signal control listening on ${address.address}:${address.port}\n`,
  );

  let closing = false;
  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;

    await new Promise<void>((resolve) => server.close(() => resolve()));
    await runtime.close();
  };

  process.once("SIGINT", () => {
    void close().finally(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void close().finally(() => process.exit(0));
  });
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown DEV control failure.";
  process.stderr.write(`DELTA DEV control failed: ${message}\n`);
  process.exitCode = 1;
});
