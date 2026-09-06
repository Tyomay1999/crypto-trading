import assert from "node:assert/strict";
import test from "node:test";

import {
  loadAuthEnv,
} from "../dist/auth/config.js";

const validSecret =
  "0123456789abcdef0123456789abcdef0123456789abcdef";

test("auth configuration accepts secure local origin", () => {
  const env = loadAuthEnv({
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
