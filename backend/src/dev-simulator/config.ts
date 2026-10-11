export type DevSimulatorConfig = Readonly<{
  enabled: true;
  host: string;
  port: number;
  databaseUrl: string;
  allowReset: boolean;
}>;

function required(name: string, env: NodeJS.ProcessEnv): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required for DEV signal simulator.`);
  }
  return value;
}

function boundedPort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 3900;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1024 || value > 65535) {
    throw new Error("DELTA_DEV_SIGNAL_SIMULATOR_PORT must be an integer between 1024 and 65535.");
  }
  return value;
}

export function loadDevSimulatorConfig(
  env: NodeJS.ProcessEnv = process.env,
): DevSimulatorConfig {
  if (env.NODE_ENV === "production") {
    throw new Error("DEV signal simulator must never run with NODE_ENV=production.");
  }

  if (env.DELTA_DEV_SIGNAL_SIMULATOR !== "on") {
    throw new Error("DELTA_DEV_SIGNAL_SIMULATOR=on is required.");
  }

  const host = (env.DELTA_DEV_SIGNAL_SIMULATOR_HOST ?? "127.0.0.1").trim();
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw new Error("DEV signal simulator must bind to loopback only.");
  }

  return {
    enabled: true,
    host,
    port: boundedPort(env.DELTA_DEV_SIGNAL_SIMULATOR_PORT),
    databaseUrl: required("DATABASE_URL", env),
    allowReset: env.DELTA_DEV_SIGNAL_SIMULATOR_ALLOW_RESET === "yes",
  };
}
