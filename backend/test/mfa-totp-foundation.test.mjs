import assert from "node:assert/strict";
import {
  readFile,
} from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = process.cwd();

const corePath =
  path.join(
    root,
    "src",
    "auth",
    "core.ts",
  );

const migrationPath =
  path.join(
    root,
    "migrations",
    "0004_mfa_totp_foundation.sql",
  );

async function core() {
  return readFile(
    corePath,
    "utf8",
  );
}

async function migration() {
  return readFile(
    migrationPath,
    "utf8",
  );
}

test(
  "A4 wires Better Auth two-factor plugin",
  async () => {
    const source = await core();

    assert.match(
      source,
      /from "better-auth\/plugins\/two-factor"/,
    );

    assert.equal(
      (
        source.match(
          /twoFactor\(\{/g,
        ) ?? []
      ).length,
      1,
    );
  },
);

test(
  "TOTP enrollment requires first-code verification",
  async () => {
    const source = await core();

    assert.match(
      source,
      /skipVerificationOnEnable:\s*(?:\n\s*)?false/,
    );

    assert.match(
      source,
      /digits:\s*6/,
    );

    assert.match(
      source,
      /period:\s*30/,
    );
  },
);

test(
  "passwordless two-factor management remains disabled",
  async () => {
    const source = await core();

    const matches =
      source.match(
        /allowPasswordless:\s*(?:\n\s*)?false/g,
      ) ?? [];

    assert.ok(
      matches.length >= 2,
    );
  },
);

test(
  "MFA account lockout is explicitly bounded",
  async () => {
    const source = await core();

    assert.match(
      source,
      /maxFailedAttempts:\s*10/,
    );

    assert.match(
      source,
      /durationSeconds:\s*(?:\n\s*)?15\s*\*\s*60/,
    );
  },
);

test(
  "Better Auth receives no usable recovery codes",
  async () => {
    const source = await core();

    assert.match(
      source,
      /customBackupCodesGenerate:[\s\S]{0,100}\(\)\s*=>\s*\[\]/,
    );
  },
);

test(
  "raw Better Auth MFA routes are contained",
  async () => {
    const source = await core();

    for (
      const route
      of [
        "/two-factor/enable",
        "/two-factor/disable",
        "/two-factor/get-totp-uri",
        "/two-factor/verify-totp",
        "/two-factor/verify-backup-code",
        "/two-factor/generate-backup-codes",
        "/two-factor/send-otp",
        "/two-factor/verify-otp",
      ]
    ) {
      assert.ok(
        source.includes(
          `"${route}"`,
        ),
        `${route} must be disabled`,
      );
    }
  },
);

test(
  "migration installs Better Auth 1.7.3 TOTP fields",
  async () => {
    const sql = await migration();

    assert.match(
      sql,
      /ALTER TABLE auth\."user"/,
    );

    assert.match(
      sql,
      /"twoFactorEnabled"\s+BOOLEAN\s+DEFAULT FALSE/i,
    );

    assert.match(
      sql,
      /CREATE TABLE auth\."twoFactor"/,
    );

    for (
      const column
      of [
        '"secret"',
        '"backupCodes"',
        '"userId"',
        '"verified"',
        '"failedVerificationCount"',
        '"lockedUntil"',
      ]
    ) {
      assert.ok(
        sql.includes(column),
        `${column} missing`,
      );
    }
  },
);

test(
  "migration indexes encrypted secret and enforces one TOTP row per user",
  async () => {
    const sql = await migration();

    assert.match(
      sql,
      /CREATE INDEX "twoFactor_secret_idx"/,
    );

    assert.match(
      sql,
      /CREATE UNIQUE INDEX "twoFactor_userId_key"/,
    );

    assert.doesNotMatch(
      sql,
      /CREATE INDEX "twoFactor_userId_idx"/,
    );
  },
);

test(
  "migration prepares durable Delta TOTP replay state",
  async () => {
    const sql = await migration();

    assert.match(
      sql,
      /CREATE TABLE app\.auth_totp_replay_guard/,
    );

    assert.match(
      sql,
      /PRIMARY KEY\s*\(\s*user_id,\s*code_digest\s*\)/,
    );

    assert.match(
      sql,
      /length\(code_digest\)\s*=\s*64/,
    );

    assert.match(
      sql,
      /expires_at\s*>\s*accepted_at/,
    );
  },
);

test(
  "no plaintext recovery credential column is introduced",
  async () => {
    const sql = await migration();

    assert.doesNotMatch(
      sql,
      /recovery_code_plaintext/i,
    );

    assert.doesNotMatch(
      sql,
      /backup_code_plaintext/i,
    );
  },
);
