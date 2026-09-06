import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTH_PASSWORD_MAX_LENGTH,
  AUTH_PASSWORD_MIN_LENGTH,
} from "../dist/auth/password-policy.js";

test(
  "Delta password policy requires long passphrases",
  () => {
    assert.equal(
      AUTH_PASSWORD_MIN_LENGTH,
      15,
    );

    assert.equal(
      AUTH_PASSWORD_MAX_LENGTH,
      128,
    );

    assert.ok(
      AUTH_PASSWORD_MAX_LENGTH >= 64,
    );
  },
);
