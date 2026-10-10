import assert from "node:assert/strict";
import {
  readFile,
} from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  symmetricDecrypt,
} from "better-auth/crypto";
import {
  createOTP,
} from "@better-auth/utils/otp";

import {
  createTotpReplacementMaterial,
  verifyEncryptedTotpCode,
} from "../dist/auth/totp-replacement.js";

const root =
  process.cwd();

async function source(...parts) {
  return readFile(
    path.join(
      root,
      ...parts,
    ),
    "utf8",
  );
}

test(
  "TOTP replacement material is encrypted and verifies only the new authenticator",
  async () => {
    const key =
      "0123456789abcdef0123456789abcdef0123456789abcdef";

    const material =
      await createTotpReplacementMaterial(
        key,
      );

    assert.equal(
      material.replacementId.length,
      32,
    );

    assert.match(
      material.totpUri,
      /^otpauth:\/\/totp\//,
    );

    const plaintextSecret =
      await symmetricDecrypt({
        key,
        data:
          material.encryptedSecret,
      });

    assert.notEqual(
      plaintextSecret,
      material.encryptedSecret,
    );

    const code =
      await createOTP(
        plaintextSecret,
        {
          digits: 6,
          period: 30,
        },
      ).totp();

    assert.equal(
      await verifyEncryptedTotpCode(
        key,
        material.encryptedSecret,
        code,
      ),
      true,
    );

    assert.equal(
      await verifyEncryptedTotpCode(
        key,
        material.encryptedSecret,
        "00000",
      ),
      false,
    );
  },
);

test(
  "replacement migration stores no plaintext pending TOTP secret",
  async () => {
    const migration =
      await source(
        "migrations",
        "0004_mfa_totp_foundation.sql",
      );

    assert.match(
      migration,
      /CREATE TABLE app\.auth_totp_replacement/,
    );

    assert.match(
      migration,
      /encrypted_secret TEXT NOT NULL/,
    );

    assert.doesNotMatch(
      migration,
      /\n\s+secret TEXT NOT NULL/,
    );
  },
);

test(
  "replacement keeps active factor intact until atomic finalization",
  async () => {
    const storage =
      await source(
        "src",
        "storage",
        "totp-replacement.ts",
      );

    const finalize =
      storage.indexOf(
        "export async function finalizeTotpReplacement",
      );

    assert.ok(finalize >= 0);

    const block =
      storage.slice(finalize);

    assert.match(
      block,
      /FOR UPDATE/,
    );

    assert.match(
      block,
      /UPDATE auth\."twoFactor"/,
    );

    assert.match(
      block,
      /DELETE FROM app\.auth_totp_replacement/,
    );

    assert.match(
      block,
      /DELETE FROM auth\."session"/,
    );

    assert.match(
      block,
      /"id" <> \$2/,
    );
  },
);

test(
  "replacement requires password, old TOTP and new TOTP",
  async () => {
    const routes =
      await source(
        "src",
        "routes",
        "mfa-totp.routes.ts",
      );

    assert.match(
      routes,
      /"\/replace\/start"/,
    );

    assert.match(
      routes,
      /parsePasswordBody/,
    );

    assert.match(
      routes,
      /"\/replace\/verify"/,
    );

    assert.match(
      routes,
      /currentCode/,
    );

    assert.match(
      routes,
      /newCode/,
    );

    assert.match(
      routes,
      /verifyEncryptedTotpCode/,
    );
  },
);

test(
  "replacement is bounded, expiring and generation-bound",
  async () => {
    const storage =
      await source(
        "src",
        "storage",
        "totp-replacement.ts",
      );

    assert.match(
      storage,
      /MAX_REPLACEMENT_FAILURES = 5/,
    );

    assert.match(
      storage,
      /replacement_id = \$2/,
    );

    assert.match(
      storage,
      /expires_at > \$3/,
    );

    assert.match(
      storage,
      /failed_verification_count/,
    );
  },
);

test(
  "successful replacement seeds replay protection for new authenticator",
  async () => {
    const routes =
      await source(
        "src",
        "routes",
        "mfa-totp.routes.ts",
      );

    const replace =
      routes.indexOf(
        '"/replace/verify"',
      );

    assert.ok(replace >= 0);

    const block =
      routes.slice(
        replace,
        replace + 9000,
      );

    assert.match(
      block,
      /createTotpReplayDigest/,
    );

    assert.match(
      block,
      /finalizeTotpReplacement/,
    );

    assert.match(
      block,
      /status\(204\)/,
    );
  },
);


test(
  "replacement storage accepts the narrow MFA database contract",
  async () => {
    const storage =
      await source(
        "src",
        "storage",
        "totp-replacement.ts",
      );

    assert.match(
      storage,
      /type TotpReplacementDatabase[\s\S]*Pick<[\s\S]*Pool,[\s\S]*"connect" \| "query"/,
    );

    assert.doesNotMatch(
      storage,
      /pool: Pool,/,
    );
  },
);

test(
  "replacement does not mutate recovery credential state",
  async () => {
    const storage =
      await source(
        "src",
        "storage",
        "totp-replacement.ts",
      );

    const finalize =
      storage.indexOf(
        "export async function finalizeTotpReplacement",
      );

    assert.ok(
      finalize >= 0,
    );

    const finalizationBlock =
      storage.slice(
        finalize,
      );

    assert.doesNotMatch(
      finalizationBlock,
      /"backupCodes"\s*=/,
    );
  },
);
