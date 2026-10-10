import assert from "node:assert/strict";
import test from "node:test";

import {
  logMfaSecurityAuditEvent,
} from "../dist/auth/mfa-security-audit.js";

test(
  "MFA audit exposes only correlation-safe fields",
  () => {
    const entries = [];

    const original =
      console.log;

    console.log =
      (value) => {
        entries.push(value);
      };

    try {
      logMfaSecurityAuditEvent(
        "delta-mfa-request-001",
        "totp_login_challenge_verified",
        "success",
      );
    } finally {
      console.log =
        original;
    }

    assert.equal(
      entries.length,
      1,
    );

    const payload =
      JSON.parse(
        entries[0],
      );

    assert.deepEqual(
      payload,
      {
        event:
          "auth_mfa_security_event",

        requestId:
          "delta-mfa-request-001",

        action:
          "totp_login_challenge_verified",

        outcome:
          "success",
      },
    );

    for (
      const forbidden
      of [
        "userId",
        "sessionId",
        "token",
        "code",
        "email",
        "ipAddress",
        "userAgent",
      ]
    ) {
      assert.equal(
        forbidden in payload,
        false,
      );
    }
  },
);

test(
  "recovery MFA audit actions and outcomes retain the minimal allowlist",
  () => {
    const entries = [];
    const original = console.log;

    console.log = value => {
      entries.push(value);
    };

    try {
      for (const action of [
        "recovery_codes_generated",
        "recovery_codes_regenerated",
        "recovery_code_challenge_verified",
      ]) {
        for (const outcome of [
          "success",
          "rejected",
          "rate_limited",
        ]) {
          logMfaSecurityAuditEvent(
            "server-generated-request-id",
            action,
            outcome,
          );
        }
      }
    } finally {
      console.log = original;
    }

    assert.equal(entries.length, 9);

    for (const entry of entries) {
      const payload = JSON.parse(entry);

      assert.deepEqual(
        Object.keys(payload).sort(),
        [
          "action",
          "event",
          "outcome",
          "requestId",
        ],
      );

      assert.doesNotMatch(
        entry,
        /sentinel-recovery-code|sentinel-digest|password|totp|session|email|user-agent|203\.0\.113\.9|2fa-/i,
      );
    }
  },
);
