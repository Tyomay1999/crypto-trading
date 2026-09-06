const DEFAULT_PORT = 3001;
const DEFAULT_SHUTDOWN_GRACE_MS = 10_000;

export type NodeEnvironment =
  | "development"
  | "test"
  | "production";

export type AppEnvironment = Readonly<{
  nodeEnv: NodeEnvironment;
  port: number;
  shutdownGraceMs: number;
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

export function loadEnv(
  source: NodeJS.ProcessEnv = process.env,
): AppEnvironment {
  return Object.freeze({
    nodeEnv: parseNodeEnvironment(source.NODE_ENV),
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
  });
}
