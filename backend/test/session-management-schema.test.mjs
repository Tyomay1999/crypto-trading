import assert from "node:assert/strict";
import {
  readFile,
} from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "../migrations/0003_session_management.sql",
  import.meta.url,
);

const migration =
  await readFile(
    migrationUrl,
    "utf8",
  );

test(
  "A3 session activity table is app-owned",
  () => {
    assert.match(
      migration,
      /CREATE\s+TABLE\s+app\.auth_session_activity\s*\(/i,
    );

    assert.doesNotMatch(
      migration,
      /CREATE\s+TABLE\s+auth\./i,
    );

    assert.doesNotMatch(
      migration,
      /ALTER\s+TABLE\s+auth\."?session"?/i,
    );
  },
);

test(
  "A3 activity ownership follows Better Auth session identity",
  () => {
    assert.match(
      migration,
      /session_id\s+TEXT\s+PRIMARY\s+KEY/i,
    );

    assert.match(
      migration,
      /REFERENCES\s+auth\."session"\s*\(\s*"id"\s*\)/i,
    );

    assert.match(
      migration,
      /ON\s+DELETE\s+CASCADE/i,
    );

    /*
     * user_id is intentionally not duplicated.
     * Ownership must always come from auth.session.
     */
    assert.doesNotMatch(
      migration,
      /\buser_id\b/i,
    );
  },
);

test(
  "A3 activity table stores an explicit last activity timestamp",
  () => {
    assert.match(
      migration,
      /last_activity_at\s+TIMESTAMPTZ\s+NOT\s+NULL/i,
    );
  },
);

test(
  "A3 activity storage contains no authentication secrets or fingerprint data",
  () => {
    const tableDefinition =
      migration.match(
        /CREATE\s+TABLE\s+app\.auth_session_activity\s*\(([\s\S]*?)\);/i,
      )?.[1];

    assert.ok(
      tableDefinition,
      "Unable to locate auth_session_activity table definition",
    );

    assert.doesNotMatch(
      tableDefinition,
      /\btoken\b/i,
    );

    assert.doesNotMatch(
      tableDefinition,
      /\bpassword\b/i,
    );

    assert.doesNotMatch(
      tableDefinition,
      /\bip(?:_address)?\b/i,
    );

    assert.doesNotMatch(
      tableDefinition,
      /\buser_agent\b/i,
    );

    assert.doesNotMatch(
      tableDefinition,
      /\bfingerprint\b/i,
    );

    assert.doesNotMatch(
      tableDefinition,
      /\bcanvas\b/i,
    );

    assert.doesNotMatch(
      tableDefinition,
      /\bwebgl\b/i,
    );

    assert.doesNotMatch(
      tableDefinition,
      /\bhardware\b/i,
    );
  },
);

test(
  "A3 migration does not persist duplicate device metadata",
  () => {
    const tableDefinition =
      migration.match(
        /CREATE\s+TABLE\s+app\.auth_session_activity\s*\(([\s\S]*?)\);/i,
      )?.[1];

    assert.ok(tableDefinition);

    assert.doesNotMatch(
      tableDefinition,
      /\bbrowser\b/i,
    );

    assert.doesNotMatch(
      tableDefinition,
      /\bos\b/i,
    );

    assert.doesNotMatch(
      tableDefinition,
      /\bdevice\b/i,
    );

    assert.doesNotMatch(
      tableDefinition,
      /\bmetadata\b/i,
    );
  },
);
