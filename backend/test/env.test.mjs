import assert from "node:assert/strict";
import test from "node:test";

import { loadEnv } from "../dist/config/env.js";

test("configuration uses safe defaults", () => {
  const env = loadEnv({});

  assert.deepEqual(env, {
    nodeEnv: "development",
    port: 3001,
    shutdownGraceMs: 10_000,
  });
});

test("configuration accepts valid explicit values", () => {
  const env = loadEnv({
    NODE_ENV: "production",
    PORT: "4000",
    SHUTDOWN_GRACE_MS: "15000",
  });

  assert.deepEqual(env, {
    nodeEnv: "production",
    port: 4000,
    shutdownGraceMs: 15_000,
  });
});

test("configuration rejects invalid NODE_ENV", () => {
  assert.throws(
    () => loadEnv({ NODE_ENV: "invalid" }),
    /Invalid NODE_ENV value/,
  );
});

test("configuration rejects invalid PORT", () => {
  assert.throws(
    () => loadEnv({ PORT: "70000" }),
    /Invalid PORT value/,
  );
});

test("configuration rejects invalid shutdown grace period", () => {
  assert.throws(
    () => loadEnv({ SHUTDOWN_GRACE_MS: "0" }),
    /Invalid SHUTDOWN_GRACE_MS value/,
  );
});
