const DEFAULT_PORT = 3001;
const DEFAULT_SHUTDOWN_GRACE_MS = 10_000;
const DEFAULT_DATABASE_POOL_MAX = 10;
const DEFAULT_DATABASE_CONNECT_TIMEOUT_MS = 3_000;

export type NodeEnvironment =
  | "development"
  | "test"
  | "production";

export type AppEnvironment = Readonly<{
  nodeEnv: NodeEnvironment;
  port: number;
  shutdownGraceMs: number;

  databaseUrl: string;
  databasePoolMax: number;
  databaseConnectTimeoutMs: number;
}>;

function parseNodeEnvironment(
  value: string | undefined,
): NodeEnvironment {
  const candidate = value ?? "development";

  if (
    candidate === "development" ||
    candidate === "test" ||
    candidate === "production"
  ) {
    return candidate;
  }

  throw new Error(`Invalid NODE_ENV value: ${candidate}`);
}

function parseInteger(
  name: string,
  value: string | undefined,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) {
    return defaultValue;
  }

  const parsed = Number(value);

  if (
    !Number.isInteger(parsed) ||
    parsed < minimum ||
    parsed > maximum
  ) {
    throw new Error(`Invalid ${name} value: ${value}`);
  }

  return parsed;
}

function parseDatabaseUrl(
  value: string | undefined,
  nodeEnv: NodeEnvironment,
): string {
  if (value !== undefined && value.trim() !== "") {
    return value;
  }

  if (nodeEnv === "production") {
    throw new Error(
      "DATABASE_URL is required in production.",
    );
  }

  return "postgresql://delta:delta@127.0.0.1:5432/delta";
}

export function loadEnv(
  source: NodeJS.ProcessEnv = process.env,
): AppEnvironment {
  const nodeEnv = parseNodeEnvironment(source.NODE_ENV);

  return Object.freeze({
    nodeEnv,

    port: parseInteger(
      "PORT",
      source.PORT,
      DEFAULT_PORT,
      1,
      65_535,
    ),

    shutdownGraceMs: parseInteger(
      "SHUTDOWN_GRACE_MS",
      source.SHUTDOWN_GRACE_MS,
      DEFAULT_SHUTDOWN_GRACE_MS,
      100,
      120_000,
    ),

    databaseUrl: parseDatabaseUrl(
      source.DATABASE_URL,
      nodeEnv,
    ),

    databasePoolMax: parseInteger(
      "DATABASE_POOL_MAX",
      source.DATABASE_POOL_MAX,
      DEFAULT_DATABASE_POOL_MAX,
      1,
      100,
    ),

    databaseConnectTimeoutMs: parseInteger(
      "DATABASE_CONNECT_TIMEOUT_MS",
      source.DATABASE_CONNECT_TIMEOUT_MS,
      DEFAULT_DATABASE_CONNECT_TIMEOUT_MS,
      100,
      30_000,
    ),
  });
}
