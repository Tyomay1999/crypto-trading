import assert from "node:assert/strict";
import test from "node:test";

import {
  loadAuthEnv,
} from "../dist/auth/config.js";

const validSecret =
  "0123456789abcdef0123456789abcdef0123456789abcdef";

const validReplayPepper =
  "abcdef0123456789abcdef0123456789abcdef0123456789";

const validRecoveryPepper =
  "recovery-test-pepper-independent-0123456789";

const validLocalWebAuthn = Object.freeze({
  WEBAUTHN_RP_ID:
    "localhost",
  WEBAUTHN_RP_NAME:
    "Delta",
  WEBAUTHN_ORIGIN:
    "http://localhost:8080",
});

const validHttpsWebAuthn = Object.freeze({
  WEBAUTHN_RP_ID:
    "delta.example.com",
  WEBAUTHN_RP_NAME:
    "Delta",
  WEBAUTHN_ORIGIN:
    "https://delta.example.com",
});

test("auth configuration accepts secure local origin", () => {
  const env = loadAuthEnv({
    ...validLocalWebAuthn,
    RECOVERY_CODE_PEPPER:
      validRecoveryPepper,
    TOTP_REPLAY_PEPPER:
      validReplayPepper,
    BETTER_AUTH_SECRET:
      validSecret,
    BETTER_AUTH_BASE_URL:
      "http://localhost:8080",
    BETTER_AUTH_TRUSTED_ORIGINS:
      "http://localhost:3001,http://localhost:8080",
  });

  assert.equal(
    env.secret,
    validSecret,
  );

  assert.equal(
    env.baseUrl,
    "http://localhost:8080",
  );

  assert.equal(
    env.useSecureCookies,
    false,
  );

  assert.deepEqual(
    [...env.trustedOrigins],
    [
      "http://localhost:8080",
      "http://localhost:3001",
    ],
  );
});

test("auth configuration enables secure cookies for HTTPS", () => {
  const env = loadAuthEnv({
    ...validHttpsWebAuthn,
    RECOVERY_CODE_PEPPER:
      validRecoveryPepper,
    TOTP_REPLAY_PEPPER:
      validReplayPepper,
    BETTER_AUTH_SECRET:
      validSecret,
    BETTER_AUTH_BASE_URL:
      "https://delta.example.com",
  });

  assert.equal(
    env.useSecureCookies,
    true,
  );
});

test("auth configuration rejects weak secret", () => {
  assert.throws(
    () =>
      loadAuthEnv({
        RECOVERY_CODE_PEPPER:
          validRecoveryPepper,
        TOTP_REPLAY_PEPPER:
          validReplayPepper,
        BETTER_AUTH_SECRET:
          "too-short",
        BETTER_AUTH_BASE_URL:
          "http://localhost:8080",
      }),
    /at least 32 characters/,
  );
});

test("auth configuration requires base URL", () => {
  assert.throws(
    () =>
      loadAuthEnv({
        RECOVERY_CODE_PEPPER:
          validRecoveryPepper,
        TOTP_REPLAY_PEPPER:
          validReplayPepper,
        BETTER_AUTH_SECRET:
          validSecret,
      }),
    /BETTER_AUTH_BASE_URL is required/,
  );
});

test("auth configuration rejects credential-bearing base URL", () => {
  assert.throws(
    () =>
      loadAuthEnv({
        RECOVERY_CODE_PEPPER:
          validRecoveryPepper,
        TOTP_REPLAY_PEPPER:
          validReplayPepper,
        BETTER_AUTH_SECRET:
          validSecret,
        BETTER_AUTH_BASE_URL:
          "https://user:password@example.com",
      }),
    /must not contain credentials/,
  );
});

test("auth configuration rejects invalid trusted origin", () => {
  assert.throws(
    () =>
      loadAuthEnv({
        RECOVERY_CODE_PEPPER:
          validRecoveryPepper,
        TOTP_REPLAY_PEPPER:
          validReplayPepper,
        BETTER_AUTH_SECRET:
          validSecret,
        BETTER_AUTH_BASE_URL:
          "https://delta.example.com",
        BETTER_AUTH_TRUSTED_ORIGINS:
          "file:///tmp/auth",
      }),
    /Trusted origin must use http or https/,
  );
});

test(
  "auth configuration exposes dedicated TOTP replay pepper",
  () => {
    const env =
      loadAuthEnv({
        ...validHttpsWebAuthn,
        RECOVERY_CODE_PEPPER:
          validRecoveryPepper,
        BETTER_AUTH_SECRET:
          validSecret,

        TOTP_REPLAY_PEPPER:
          validReplayPepper,

        BETTER_AUTH_BASE_URL:
          "https://delta.example.com",
      });

    assert.equal(
      env.replayPepper,
      validReplayPepper,
    );
  },
);

test(
  "auth configuration requires dedicated TOTP replay pepper",
  () => {
    assert.throws(
      () =>
        loadAuthEnv({
          RECOVERY_CODE_PEPPER:
            validRecoveryPepper,
          BETTER_AUTH_SECRET:
            validSecret,

          BETTER_AUTH_BASE_URL:
            "https://delta.example.com",
        }),

      /TOTP_REPLAY_PEPPER must contain at least 32 characters/,
    );
  },
);

test(
  "auth configuration rejects Better Auth secret reuse as TOTP replay pepper",
  () => {
    assert.throws(
      () =>
        loadAuthEnv({
          RECOVERY_CODE_PEPPER:
            validRecoveryPepper,
          BETTER_AUTH_SECRET:
            validSecret,

          TOTP_REPLAY_PEPPER:
            validSecret,

          BETTER_AUTH_BASE_URL:
            "https://delta.example.com",
        }),

      /must be independent from BETTER_AUTH_SECRET/,
    );
  },
);

test(
  "auth configuration exposes a dedicated recovery pepper",
  () => {
    const env = loadAuthEnv({
      ...validHttpsWebAuthn,
      BETTER_AUTH_SECRET:
        validSecret,
      TOTP_REPLAY_PEPPER:
        validReplayPepper,
      RECOVERY_CODE_PEPPER:
        validRecoveryPepper,
      BETTER_AUTH_BASE_URL:
        "https://delta.example.com",
    });

    assert.equal(
      env.recoveryPepper,
      validRecoveryPepper,
    );
  },
);

test(
  "auth configuration requires at least 32 UTF-8 recovery-pepper bytes",
  () => {
    for (const recoveryPepper of [
      undefined,
      "x".repeat(31),
      "é".repeat(15),
    ]) {
      assert.throws(
        () =>
          loadAuthEnv({
            ...validHttpsWebAuthn,
            BETTER_AUTH_SECRET:
              validSecret,
            TOTP_REPLAY_PEPPER:
              validReplayPepper,
            RECOVERY_CODE_PEPPER:
              recoveryPepper,
            BETTER_AUTH_BASE_URL:
              "https://delta.example.com",
          }),
        /RECOVERY_CODE_PEPPER must contain at least 32 UTF-8 bytes/,
      );
    }

    assert.equal(
      loadAuthEnv({
        ...validHttpsWebAuthn,
        BETTER_AUTH_SECRET:
          validSecret,
        TOTP_REPLAY_PEPPER:
          validReplayPepper,
        RECOVERY_CODE_PEPPER:
          "é".repeat(16),
        BETTER_AUTH_BASE_URL:
          "https://delta.example.com",
      }).recoveryPepper,
      "é".repeat(16),
    );
  },
);

test(
  "auth configuration rejects recovery pepper reuse",
  () => {
    for (const recoveryPepper of [
      validSecret,
      validReplayPepper,
    ]) {
      assert.throws(
        () =>
          loadAuthEnv({
            BETTER_AUTH_SECRET:
              validSecret,
            TOTP_REPLAY_PEPPER:
              validReplayPepper,
            RECOVERY_CODE_PEPPER:
              recoveryPepper,
            BETTER_AUTH_BASE_URL:
              "https://delta.example.com",
          }),
        /RECOVERY_CODE_PEPPER must be independent/,
      );
    }
  },
);
