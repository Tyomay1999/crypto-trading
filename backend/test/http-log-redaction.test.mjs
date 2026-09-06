import assert from "node:assert/strict";
import test from "node:test";

import {
  redactSensitiveHttpTarget,
} from "../dist/security/http-log-redaction.js";

test(
  "password reset path credential is redacted",
  () => {
    const token =
      "reset-secret-token-123456789";

    const result =
      redactSensitiveHttpTarget(
        `/api/auth/reset-password/${token}`,
      );

    assert.equal(
      result,
      "/api/auth/reset-password/[REDACTED]",
    );

    assert.equal(
      result.includes(token),
      false,
    );
  },
);

test(
  "verification token query value is redacted",
  () => {
    const token =
      "verification-secret-token";

    const result =
      redactSensitiveHttpTarget(
        `/api/auth/verify-email?token=${token}`,
      );

    assert.equal(
      result.includes(token),
      false,
    );

    assert.match(
      result,
      /token=\[REDACTED\]/,
    );
  },
);

test(
  "OAuth code and state query values are redacted",
  () => {
    const result =
      redactSensitiveHttpTarget(
        "/api/auth/callback/test?code=secret-code&state=secret-state",
      );

    assert.equal(
      result.includes("secret-code"),
      false,
    );

    assert.equal(
      result.includes("secret-state"),
      false,
    );
  },
);

test(
  "access and refresh token query values are redacted",
  () => {
    const result =
      redactSensitiveHttpTarget(
        "/callback?access_token=aaa&refresh_token=bbb",
      );

    assert.equal(
      result.includes("aaa"),
      false,
    );

    assert.equal(
      result.includes("bbb"),
      false,
    );
  },
);

test(
  "ordinary health path is unchanged",
  () => {
    assert.equal(
      redactSensitiveHttpTarget(
        "/health/ready",
      ),
      "/health/ready",
    );
  },
);

test(
  "ordinary auth endpoint is unchanged",
  () => {
    assert.equal(
      redactSensitiveHttpTarget(
        "/api/auth/sign-in/email",
      ),
      "/api/auth/sign-in/email",
    );
  },
);
