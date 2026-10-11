import { Pool } from "pg";
import { PostgresProjectionWriter } from "../projection/postgres-writer.js";
import { DevSignalController } from "./control.js";
import { loadDevSimulatorConfig } from "./config.js";

export type DevSimulatorRuntime = Readonly<{
  pool: Pool;
  controller: DevSignalController;
  close(): Promise<void>;
}>;

export function createDevSimulatorRuntime(
  env: NodeJS.ProcessEnv = process.env,
): DevSimulatorRuntime {
  const config = loadDevSimulatorConfig(env);
  const pool = new Pool({ connectionString: config.databaseUrl });
  const writer = new PostgresProjectionWriter(pool);
  const controller = new DevSignalController(writer);

  return {
    pool,
    controller,
    async close() {
      await pool.end();
    },
  };
}
