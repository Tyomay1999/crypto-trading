import assert from "node:assert/strict";
import test from "node:test";

import { loadEnv } from "../dist/config/env.js";

test("development configuration uses safe defaults", () => {
  const env = loadEnv({});

  assert.deepEqual(env, {
    nodeEnv: "development",
    port: 3001,
    shutdownGraceMs: 10_000,
    databaseUrl:
      "postgresql://delta:delta@127.0.0.1:5432/delta",
    databasePoolMax: 10,
    databaseConnectTimeoutMs: 3_000,
  });
});

test("configuration accepts valid explicit values", () => {
  const env = loadEnv({
    NODE_ENV: "production",
    PORT: "4000",
    SHUTDOWN_GRACE_MS: "15000",
    DATABASE_URL:
      "postgresql://user:pass@postgres:5432/delta",
    DATABASE_POOL_MAX: "20",
    DATABASE_CONNECT_TIMEOUT_MS: "5000",
  });

  assert.deepEqual(env, {
    nodeEnv: "production",
    port: 4000,
    shutdownGraceMs: 15_000,
    databaseUrl:
      "postgresql://user:pass@postgres:5432/delta",
    databasePoolMax: 20,
    databaseConnectTimeoutMs: 5_000,
  });
});

test("production configuration requires DATABASE_URL", () => {
  assert.throws(
    () =>
      loadEnv({
        NODE_ENV: "production",
      }),
    /DATABASE_URL is required in production/,
  );
});

test("configuration rejects invalid NODE_ENV", () => {
  assert.throws(
    () =>
      loadEnv({
        NODE_ENV: "invalid",
      }),
    /Invalid NODE_ENV value/,
  );
});

test("configuration rejects invalid PORT", () => {
  assert.throws(
    () =>
      loadEnv({
        PORT: "70000",
      }),
    /Invalid PORT value/,
  );
});

test("configuration rejects invalid shutdown grace period", () => {
  assert.throws(
    () =>
      loadEnv({
        SHUTDOWN_GRACE_MS: "0",
      }),
    /Invalid SHUTDOWN_GRACE_MS value/,
  );
});

test("configuration rejects invalid database pool size", () => {
  assert.throws(
    () =>
      loadEnv({
        DATABASE_POOL_MAX: "0",
      }),
    /Invalid DATABASE_POOL_MAX value/,
  );
});

test("configuration rejects invalid database connect timeout", () => {
  assert.throws(
    () =>
      loadEnv({
        DATABASE_CONNECT_TIMEOUT_MS: "0",
      }),
    /Invalid DATABASE_CONNECT_TIMEOUT_MS value/,
  );
});
