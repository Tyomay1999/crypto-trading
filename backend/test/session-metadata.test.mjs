import assert from "node:assert/strict";
import test from "node:test";

import {
  classifySessionDevice,
  maskSessionIp,
  projectManagedSession,
  projectManagedSessions,
} from "../dist/auth/session-metadata.js";

import {
  listActiveSessions,
} from "../dist/storage/session-inventory.js";

test(
  "session inventory reads active metadata in one query without selecting bearer token",
  async () => {
    let capturedSql = "";
    let capturedParameters;

    const observedAt =
      new Date(
        "2026-09-06T19:00:00.000Z",
      );

    const database = {
      query: async (
        sql,
        parameters,
      ) => {
        capturedSql = sql;
        capturedParameters =
          parameters;

        return {
          rowCount: 1,
          rows: [
            {
              session_id:
                "session-a",
              created_at:
                new Date(
                  "2026-09-06T18:00:00.000Z",
                ),
              expires_at:
                new Date(
                  "2026-09-13T18:00:00.000Z",
                ),
              ip_address:
                "203.0.113.42",
              user_agent:
                "Example Agent",
              last_activity_at:
                new Date(
                  "2026-09-06T18:30:00.000Z",
                ),
            },
          ],
        };
      },
    };

    const sessions =
      await listActiveSessions(
        database,
        "user-a",
        observedAt,
      );

    assert.equal(
      sessions.length,
      1,
    );

    assert.equal(
      sessions[0].sessionId,
      "session-a",
    );

    assert.match(
      capturedSql,
      /FROM\s+auth\."session"/i,
    );

    assert.match(
      capturedSql,
      /LEFT\s+JOIN\s+app\.auth_session_activity/i,
    );

    assert.match(
      capturedSql,
      /COALESCE\s*\([\s\S]*last_activity_at[\s\S]*"createdAt"/i,
    );

    assert.match(
      capturedSql,
      /"userId"\s*=\s*\$1/i,
    );

    assert.match(
      capturedSql,
      /"expiresAt"\s*>\s*\$2/i,
    );

    /*
     * Stronger than response redaction:
     * the list path must not load the token.
     */
    assert.doesNotMatch(
      capturedSql,
      /"token"/i,
    );

    assert.deepEqual(
      capturedParameters,
      [
        "user-a",
        observedAt,
      ],
    );
  },
);

test(
  "session inventory rejects empty user identity before database access",
  async () => {
    let queried = false;

    await assert.rejects(
      () =>
        listActiveSessions(
          {
            query: async () => {
              queried = true;
              throw new Error(
                "must not query",
              );
            },
          },
          "   ",
          new Date(),
        ),
      /User ID must not be empty/,
    );

    assert.equal(
      queried,
      false,
    );
  },
);

test(
  "session inventory rejects an invalid observation timestamp",
  async () => {
    let queried = false;

    await assert.rejects(
      () =>
        listActiveSessions(
          {
            query: async () => {
              queried = true;
              throw new Error(
                "must not query",
              );
            },
          },
          "user-a",
          new Date(Number.NaN),
        ),
      /timestamp must be valid/,
    );

    assert.equal(
      queried,
      false,
    );
  },
);

test(
  "IPv4 display is masked and IPv6 is deliberately coarse",
  () => {
    assert.equal(
      maskSessionIp(
        "203.0.113.42",
      ),
      "203.0.113.xxx",
    );

    assert.equal(
      maskSessionIp(
        "2001:db8:abcd:12::1",
      ),
      "IPv6",
    );

    assert.equal(
      maskSessionIp(
        "not-an-ip",
      ),
      null,
    );

    assert.equal(
      maskSessionIp(null),
      null,
    );
  },
);

test(
  "device classifier exposes only coarse Edge Windows desktop families",
  () => {
    const metadata =
      classifySessionDevice(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
          "AppleWebKit/537.36 (KHTML, like Gecko) " +
          "Chrome/151.0.0.0 Safari/537.36 Edg/151.0.0.0",
      );

    assert.deepEqual(
      metadata,
      {
        browser: "Edge",
        os: "Windows",
        type: "desktop",
      },
    );

    assert.equal(
      JSON.stringify(metadata)
        .includes("151"),
      false,
    );
  },
);

test(
  "device classifier recognizes Safari on iPhone without versions or model",
  () => {
    const metadata =
      classifySessionDevice(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) " +
          "AppleWebKit/605.1.15 (KHTML, like Gecko) " +
          "Version/19.0 Mobile/15E148 Safari/604.1",
      );

    assert.deepEqual(
      metadata,
      {
        browser: "Safari",
        os: "iOS",
        type: "mobile",
      },
    );
  },
);

test(
  "Android without Mobile token is classified only as a tablet family",
  () => {
    const metadata =
      classifySessionDevice(
        "Mozilla/5.0 (Linux; Android 16; Tablet) " +
          "AppleWebKit/537.36 (KHTML, like Gecko) " +
          "Chrome/151.0.0.0 Safari/537.36",
      );

    assert.deepEqual(
      metadata,
      {
        browser: "Chrome",
        os: "Android",
        type: "tablet",
      },
    );
  },
);

test(
  "unknown user agent is not echoed into safe metadata",
  () => {
    const raw =
      "PrivateDevice/12345 UniqueHardware/SECRET";

    const metadata =
      classifySessionDevice(
        raw,
      );

    assert.deepEqual(
      metadata,
      {
        browser: "Unknown",
        os: "Unknown",
        type: "unknown",
      },
    );

    assert.equal(
      JSON.stringify(metadata)
        .includes(raw),
      false,
    );
  },
);

test(
  "managed session projection marks current session and exposes safe timestamps only",
  () => {
    const view =
      projectManagedSession(
        {
          sessionId:
            "session-a",

          createdAt:
            new Date(
              "2026-09-06T18:00:00.000Z",
            ),

          lastActivityAt:
            new Date(
              "2026-09-06T18:30:00.000Z",
            ),

          expiresAt:
            new Date(
              "2026-09-13T18:00:00.000Z",
            ),

          ipAddress:
            "203.0.113.42",

          userAgent:
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
              "AppleWebKit/537.36 (KHTML, like Gecko) " +
              "Chrome/151.0.0.0 Safari/537.36",
        },
        "session-a",
      );

    assert.deepEqual(
      view,
      {
        id:
          "session-a",

        current:
          true,

        createdAt:
          "2026-09-06T18:00:00.000Z",

        lastActivityAt:
          "2026-09-06T18:30:00.000Z",

        expiresAt:
          "2026-09-13T18:00:00.000Z",

        device: {
          browser:
            "Chrome",
          os:
            "Windows",
          type:
            "desktop",
        },

        network: {
          ipHint:
            "203.0.113.xxx",
        },
      },
    );
  },
);

test(
  "managed session projection never exposes raw source metadata or auth ownership",
  () => {
    const rawIp =
      "198.51.100.99";

    const rawUa =
      "PrivateBrowser/999 SecretDevice/ABC";

    const views =
      projectManagedSessions(
        [
          {
            sessionId:
              "session-current",
            createdAt:
              new Date(
                "2026-09-06T18:00:00.000Z",
              ),
            lastActivityAt:
              new Date(
                "2026-09-06T18:10:00.000Z",
              ),
            expiresAt:
              new Date(
                "2026-09-13T18:00:00.000Z",
              ),
            ipAddress:
              rawIp,
            userAgent:
              rawUa,
          },
          {
            sessionId:
              "session-other",
            createdAt:
              new Date(
                "2026-09-06T17:00:00.000Z",
              ),
            lastActivityAt:
              new Date(
                "2026-09-06T17:30:00.000Z",
              ),
            expiresAt:
              new Date(
                "2026-09-13T17:00:00.000Z",
              ),
            ipAddress:
              null,
            userAgent:
              null,
          },
        ],
        "session-current",
      );

    assert.equal(
      views.filter(
        (view) => view.current,
      ).length,
      1,
    );

    const serialized =
      JSON.stringify(views);

    assert.doesNotMatch(
      serialized,
      /198\.51\.100\.99/,
    );

    assert.doesNotMatch(
      serialized,
      /PrivateBrowser/,
    );

    assert.doesNotMatch(
      serialized,
      /SecretDevice/,
    );

    assert.doesNotMatch(
      serialized,
      /userId/i,
    );

    assert.doesNotMatch(
      serialized,
      /token/i,
    );

    assert.doesNotMatch(
      serialized,
      /fingerprint/i,
    );
  },
);
