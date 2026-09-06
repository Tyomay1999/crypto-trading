import {
  createHash,
} from "node:crypto";
import {
  readdir,
  readFile,
} from "node:fs/promises";
import path from "node:path";

import type {
  Pool,
  PoolClient,
} from "pg";

const MIGRATION_FILE_PATTERN =
  /^(\d{4})_([a-z0-9_]+)\.sql$/;

const MIGRATION_LOCK_KEY = 640_271_001;

type MigrationFile = {
  version: number;
  name: string;
  sql: string;
  checksum: string;
};

function sha256(value: string): string {
  return createHash("sha256")
    .update(value)
    .digest("hex");
}

async function loadMigrations(): Promise<
  MigrationFile[]
> {
  const directory = path.join(
    process.cwd(),
    "migrations",
  );

  const entries = await readdir(directory);

  const migrations: MigrationFile[] = [];

  for (const entry of entries.sort()) {
    const match = MIGRATION_FILE_PATTERN.exec(entry);

    if (match === null) {
      continue;
    }

    const version = Number(match[1]);
    const name = match[2];

    const sql = await readFile(
      path.join(directory, entry),
      "utf8",
    );

    migrations.push({
      version,
      name,
      sql,
      checksum: sha256(sql),
    });
  }

  return migrations;
}

async function ensureMigrationTable(
  client: PoolClient,
): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS public.delta_schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

export async function runMigrations(
  pool: Pool,
): Promise<void> {
  const client = await pool.connect();

  try {
    await client.query(
      "SELECT pg_advisory_lock($1)",
      [MIGRATION_LOCK_KEY],
    );

    await ensureMigrationTable(client);

    const migrations = await loadMigrations();

    for (const migration of migrations) {
      const existing = await client.query<{
        name: string;
        checksum: string;
      }>(
        `
          SELECT name, checksum
          FROM public.delta_schema_migrations
          WHERE version = $1
        `,
        [migration.version],
      );

      if (existing.rowCount === 1) {
        const row = existing.rows[0];

        if (
          row.name !== migration.name ||
          row.checksum !== migration.checksum
        ) {
          throw new Error(
            `Migration ${migration.version} checksum mismatch.`,
          );
        }

        continue;
      }

      await client.query("BEGIN");

      try {
        await client.query(migration.sql);

        await client.query(
          `
            INSERT INTO public.delta_schema_migrations (
              version,
              name,
              checksum
            )
            VALUES ($1, $2, $3)
          `,
          [
            migration.version,
            migration.name,
            migration.checksum,
          ],
        );

        await client.query("COMMIT");

        console.log(
          JSON.stringify({
            event: "database_migration_applied",
            version: migration.version,
            name: migration.name,
          }),
        );
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    try {
      await client.query(
        "SELECT pg_advisory_unlock($1)",
        [MIGRATION_LOCK_KEY],
      );
    } finally {
      client.release();
    }
  }
}
