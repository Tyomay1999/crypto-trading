import { Pool } from "pg";

import type {
  AppEnvironment,
} from "../config/env.js";

export function createAuthDatabasePool(
  env: AppEnvironment,
): Pool {
  const pool = new Pool({
    connectionString: env.databaseUrl,

    /*
     * Better Auth owns only the auth schema.
     * Application storage remains independent.
     */
    options:
      "-c search_path=auth,public",

    max: env.databasePoolMax,

    connectionTimeoutMillis:
      env.databaseConnectTimeoutMs,

    application_name:
      "delta-backend-auth",
  });

  pool.on("error", (error) => {
    console.error(
      JSON.stringify({
        event: "auth_database_pool_error",
        message: error.message,
      }),
    );
  });

  return pool;
}
