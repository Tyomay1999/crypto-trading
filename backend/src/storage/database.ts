import { Pool } from "pg";

import type {
  AppEnvironment,
} from "../config/env.js";

export function createDatabasePool(
  env: AppEnvironment,
): Pool {
  const pool = new Pool({
    connectionString: env.databaseUrl,
    max: env.databasePoolMax,
    connectionTimeoutMillis:
      env.databaseConnectTimeoutMs,
    application_name: "delta-backend",
  });

  pool.on("error", (error) => {
    console.error(
      JSON.stringify({
        event: "database_pool_error",
        message: error.message,
      }),
    );
  });

  return pool;
}

export async function assertDatabaseReady(
  pool: Pool,
): Promise<void> {
  await pool.query("SELECT 1");
}

export async function isDatabaseReady(
  pool: Pool,
): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}
