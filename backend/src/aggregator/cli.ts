import { isAbsolute } from "node:path";
import { Pool } from "pg";
import {
  PostgresProjectionReader,
} from "../projection/reader.js";
import {
  PostgresProjectionWriter,
} from "../projection/postgres-writer.js";
import {
  readDrSourceBundles,
} from "./dr-source.js";
import {
  runDrProjectionAggregator,
} from "./runtime.js";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

async function main(): Promise<void> {
  const databasePath = requiredEnv(
    "DR_SQLITE_PATH",
  );
  if (!isAbsolute(databasePath)) {
    throw new Error(
      "DR_SQLITE_PATH must be absolute",
    );
  }

  const connectionString = requiredEnv(
    "DATABASE_URL",
  );

  const helperPath =
    process.env.DR_SQLITE_HELPER_PATH;

  const pool = new Pool({
    connectionString,
    max: 2,
    connectionTimeoutMillis: 5_000,
  });

  try {
    const reader =
      new PostgresProjectionReader(pool);
    const writer =
      new PostgresProjectionWriter(pool);

    const source = readDrSourceBundles({
      databasePath,
      ...(helperPath === undefined
        ? {}
        : { helperPath }),
    });

    const summary =
      await runDrProjectionAggregator(
        source,
        reader,
        writer,
      );

    process.stdout.write(
      `${JSON.stringify({
        status: "PASS",
        contract: "DeltaSignalProjection",
        contractVersion: 1,
        source: "DR_SQLITE_READ_ONLY",
        destination: "POSTGRES_PROJECTION",
        ...summary,
      })}\n`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  const name =
    error instanceof Error
      ? error.name
      : "UnknownError";

  process.stderr.write(
    `P11_AGGREGATOR_FAILED=${name}\n`,
  );
  process.exitCode = 1;
});
