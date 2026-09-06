import assert from "node:assert/strict";
import {
  readFile,
} from "node:fs/promises";
import test from "node:test";

import {
  createSessionSecurityAuditEvent,
} from "../dist/auth/session-security-audit.js";

test(
  "session security audit event exposes only correlation-safe fields",
  () => {
    const actions = [
      "revoke_other_session",
      "logout_current",
      "logout_everywhere",
    ];

    for (const action of actions) {
      const event =
        createSessionSecurityAuditEvent(
          "delta-audit-request-001",
          action,
        );

      assert.deepEqual(
        event,
        {
          event:
            "auth_session_security_event",
          requestId:
            "delta-audit-request-001",
          action,
          outcome:
            "success",
        },
      );

      assert.deepEqual(
        Object.keys(event).sort(),
        [
          "action",
          "event",
          "outcome",
          "requestId",
        ].sort(),
      );

      assert.equal(
        Object.hasOwn(
          event,
          "sessionId",
        ),
        false,
      );

      assert.equal(
        Object.hasOwn(
          event,
          "userId",
        ),
        false,
      );

      assert.equal(
        Object.hasOwn(
          event,
          "token",
        ),
        false,
      );

      assert.equal(
        Object.hasOwn(
          event,
          "ipAddress",
        ),
        false,
      );

      assert.equal(
        Object.hasOwn(
          event,
          "userAgent",
        ),
        false,
      );

      assert.equal(
        Object.hasOwn(
          event,
          "email",
        ),
        false,
      );
    }
  },
);

test(
  "session router fails closed unless exactly one session is current",
  async () => {
    const source =
      await readFile(
        new URL(
          "../src/routes/session.routes.ts",
          import.meta.url,
        ),
        "utf8",
      );

    assert.match(
      source,
      /const currentSessionCount\s*=/,
    );

    assert.match(
      source,
      /views\.filter\(/,
    );

    assert.match(
      source,
      /currentSessionCount !== 1/,
    );

    assert.doesNotMatch(
      source,
      /!views\.some\(/,
    );
  },
);
