import assert from "node:assert/strict";
import test from "node:test";

import {
  SessionActivityHeartbeat,
} from "../dist/auth/session-activity-heartbeat.js";

import {
  resolveCurrentSession,
} from "../dist/auth/session-context.js";

import {
  createRequireSessionMiddleware,
  getCurrentSessionContext,
} from "../dist/middleware/require-session.js";

function createSessionResponse({
  sessionId = "session-a",
  userId = "user-a",
  token = "must-never-escape",
  setCookies = [],
} = {}) {
  const headers =
    new Headers();

  for (const cookie of setCookies) {
    headers.append(
      "Set-Cookie",
      cookie,
    );
  }

  return new Response(
    JSON.stringify({
      session: {
        id:
          sessionId,
        userId,
        token,
      },
      user: {
        id:
          userId,
        email:
          "private@example.invalid",
      },
    }),
    {
      status: 200,
      headers,
    },
  );
}

function createNullSessionResponse(
  setCookies = [],
) {
  const headers =
    new Headers();

  for (const cookie of setCookies) {
    headers.append(
      "Set-Cookie",
      cookie,
    );
  }

  return new Response(
    "null",
    {
      status: 200,
      headers,
    },
  );
}

test(
  "resolveCurrentSession projects safe identity and captures Better Auth Set-Cookie",
  async () => {
    let observedCookie = null;

    const refreshedCookie =
      "delta-auth.session_token=refreshed; Path=/; HttpOnly";

    const auth = {
      api: {
        getSession:
          async ({
            headers,
            asResponse,
          }) => {
            observedCookie =
              headers.get(
                "cookie",
              );

            assert.equal(
              asResponse,
              true,
            );

            return createSessionResponse({
              setCookies: [
                refreshedCookie,
              ],
            });
          },
      },
    };

    const resolution =
      await resolveCurrentSession(
        auth,
        {
          cookie:
            "delta-auth.session_token=credential",
        },
      );

    assert.equal(
      observedCookie,
      "delta-auth.session_token=credential",
    );

    assert.deepEqual(
      resolution.context,
      {
        sessionId:
          "session-a",
        userId:
          "user-a",
      },
    );

    assert.deepEqual(
      resolution.setCookies,
      [
        refreshedCookie,
      ],
    );

    assert.equal(
      Object.hasOwn(
        resolution.context,
        "token",
      ),
      false,
    );

    assert.equal(
      Object.hasOwn(
        resolution.context,
        "email",
      ),
      false,
    );
  },
);

test(
  "resolveCurrentSession preserves stale-cookie deletion when session is absent",
  async () => {
    const staleCookie =
      "delta-auth.session_token=; Max-Age=0; Path=/; HttpOnly";

    const resolution =
      await resolveCurrentSession(
        {
          api: {
            getSession:
              async () =>
                createNullSessionResponse([
                  staleCookie,
                ]),
          },
        },
        {},
      );

    assert.equal(
      resolution.context,
      null,
    );

    assert.deepEqual(
      resolution.setCookies,
      [
        staleCookie,
      ],
    );
  },
);

test(
  "resolveCurrentSession does not misclassify Better Auth failure as unauthenticated",
  async () => {
    await assert.rejects(
      () =>
        resolveCurrentSession(
          {
            api: {
              getSession:
                async () =>
                  new Response(
                    JSON.stringify({
                      error:
                        "database unavailable",
                    }),
                    {
                      status: 500,
                    },
                  ),
            },
          },
          {},
        ),
      /session resolution failed with HTTP 500/,
    );
  },
);

test(
  "SessionActivityHeartbeat suppresses database touches inside the five-minute window",
  async () => {
    const touches = [];

    const heartbeat =
      new SessionActivityHeartbeat(
        async (
          sessionId,
          observedAt,
        ) => {
          touches.push({
            sessionId,
            observedAt,
          });
        },
      );

    const first =
      new Date(
        "2026-09-06T18:00:00.000Z",
      );

    assert.equal(
      await heartbeat.observe(
        "session-a",
        first,
      ),
      true,
    );

    assert.equal(
      await heartbeat.observe(
        "session-a",
        new Date(
          "2026-09-06T18:01:00.000Z",
        ),
      ),
      false,
    );

    assert.equal(
      await heartbeat.observe(
        "session-a",
        new Date(
          "2026-09-06T18:04:59.999Z",
        ),
      ),
      false,
    );

    assert.equal(
      await heartbeat.observe(
        "session-a",
        new Date(
          "2026-09-06T18:05:00.000Z",
        ),
      ),
      true,
    );

    assert.equal(
      touches.length,
      2,
    );
  },
);

test(
  "SessionActivityHeartbeat suppresses older observations",
  async () => {
    let touches = 0;

    const heartbeat =
      new SessionActivityHeartbeat(
        async () => {
          touches += 1;
        },
      );

    await heartbeat.observe(
      "session-a",
      new Date(
        "2026-09-06T18:10:00.000Z",
      ),
    );

    const persisted =
      await heartbeat.observe(
        "session-a",
        new Date(
          "2026-09-06T18:00:00.000Z",
        ),
      );

    assert.equal(
      persisted,
      false,
    );

    assert.equal(
      touches,
      1,
    );
  },
);

test(
  "SessionActivityHeartbeat releases its gate after a failed durable touch",
  async () => {
    let attempts = 0;

    const heartbeat =
      new SessionActivityHeartbeat(
        async () => {
          attempts += 1;

          if (attempts === 1) {
            throw new Error(
              "temporary database failure",
            );
          }
        },
      );

    const observedAt =
      new Date(
        "2026-09-06T18:00:00.000Z",
      );

    await assert.rejects(
      () =>
        heartbeat.observe(
          "session-a",
          observedAt,
        ),
      /temporary database failure/,
    );

    assert.equal(
      await heartbeat.observe(
        "session-a",
        observedAt,
      ),
      true,
    );

    assert.equal(
      attempts,
      2,
    );
  },
);

test(
  "SessionActivityHeartbeat keeps its process-local cache bounded",
  async () => {
    const touches = [];

    const heartbeat =
      new SessionActivityHeartbeat(
        async (sessionId) => {
          touches.push(
            sessionId,
          );
        },
        {
          maxTrackedSessions: 1,
        },
      );

    await heartbeat.observe(
      "session-a",
      new Date(
        "2026-09-06T18:00:00.000Z",
      ),
    );

    await heartbeat.observe(
      "session-b",
      new Date(
        "2026-09-06T18:00:01.000Z",
      ),
    );

    await heartbeat.observe(
      "session-a",
      new Date(
        "2026-09-06T18:01:00.000Z",
      ),
    );

    assert.deepEqual(
      touches,
      [
        "session-a",
        "session-b",
        "session-a",
      ],
    );
  },
);

test(
  "require-session middleware stores only safe current-session context",
  async () => {
    let activitySessionId = null;
    let activityObservedAt = null;
    let nextArgument =
      Symbol(
        "not-called",
      );

    const middleware =
      createRequireSessionMiddleware({
        auth: {
          api: {
            getSession:
              async () =>
                createSessionResponse(),
          },
        },

        observeActivity:
          async (
            sessionId,
            observedAt,
          ) => {
            activitySessionId =
              sessionId;

            activityObservedAt =
              observedAt;
          },

        now:
          () =>
            new Date(
              "2026-09-06T18:30:00.000Z",
            ),
      });

    const request = {
      headers: {
        cookie:
          "delta-auth.session_token=credential",
      },
    };

    const response = {
      locals: {
        requestId:
          "a3-c-test",
      },

      append() {},
    };

    await middleware(
      request,
      response,
      (argument) => {
        nextArgument =
          argument;
      },
    );

    assert.equal(
      nextArgument,
      undefined,
    );

    assert.equal(
      activitySessionId,
      "session-a",
    );

    assert.equal(
      activityObservedAt.toISOString(),
      "2026-09-06T18:30:00.000Z",
    );

    assert.deepEqual(
      getCurrentSessionContext(
        response,
      ),
      {
        sessionId:
          "session-a",
        userId:
          "user-a",
      },
    );
  },
);

test(
  "require-session middleware forwards Better Auth refreshed session cookie",
  async () => {
    const appended = [];

    const refreshedCookie =
      "delta-auth.session_token=refreshed; Path=/; HttpOnly";

    const middleware =
      createRequireSessionMiddleware({
        auth: {
          api: {
            getSession:
              async () =>
                createSessionResponse({
                  setCookies: [
                    refreshedCookie,
                  ],
                }),
          },
        },

        observeActivity:
          async () => {},
      });

    await middleware(
      {
        headers: {},
      },
      {
        locals: {
          requestId:
            "cookie-forward-test",
        },

        append(
          name,
          value,
        ) {
          appended.push([
            name,
            value,
          ]);
        },
      },
      () => {},
    );

    assert.deepEqual(
      appended,
      [
        [
          "Set-Cookie",
          refreshedCookie,
        ],
      ],
    );
  },
);

test(
  "require-session middleware rejects absent session after forwarding stale-cookie deletion",
  async () => {
    let activityCalled = false;
    let nextArgument;

    const appended = [];

    const staleCookie =
      "delta-auth.session_token=; Max-Age=0; Path=/; HttpOnly";

    const middleware =
      createRequireSessionMiddleware({
        auth: {
          api: {
            getSession:
              async () =>
                createNullSessionResponse([
                  staleCookie,
                ]),
          },
        },

        observeActivity:
          async () => {
            activityCalled = true;
          },
      });

    await middleware(
      {
        headers: {},
      },
      {
        locals: {
          requestId:
            "a3-c-unauthorized",
        },

        append(
          name,
          value,
        ) {
          appended.push([
            name,
            value,
          ]);
        },
      },
      (argument) => {
        nextArgument =
          argument;
      },
    );

    assert.equal(
      activityCalled,
      false,
    );

    assert.equal(
      nextArgument.statusCode,
      401,
    );

    assert.equal(
      nextArgument.code,
      "AUTHENTICATION_REQUIRED",
    );

    assert.deepEqual(
      appended,
      [
        [
          "Set-Cookie",
          staleCookie,
        ],
      ],
    );
  },
);

test(
  "activity failure does not invalidate authenticated request and logs no session identity",
  async () => {
    const logLines = [];
    const originalError =
      console.error;

    console.error =
      (...values) => {
        logLines.push(
          values.join(" "),
        );
      };

    try {
      let nextArgument =
        Symbol(
          "not-called",
        );

      const middleware =
        createRequireSessionMiddleware({
          auth: {
            api: {
              getSession:
                async () =>
                  createSessionResponse({
                    sessionId:
                      "session-secret-id",
                    userId:
                      "user-secret-id",
                    token:
                      "bearer-secret",
                  }),
            },
          },

          observeActivity:
            async () => {
              throw new Error(
                "storage unavailable",
              );
            },
        });

      const response = {
        locals: {
          requestId:
            "safe-request-id",
        },

        append() {},
      };

      await middleware(
        {
          headers: {},
        },
        response,
        (argument) => {
          nextArgument =
            argument;
        },
      );

      assert.equal(
        nextArgument,
        undefined,
      );

      assert.equal(
        logLines.length,
        1,
      );

      assert.match(
        logLines[0],
        /auth_session_activity_touch_failed/,
      );

      assert.match(
        logLines[0],
        /safe-request-id/,
      );

      assert.doesNotMatch(
        logLines[0],
        /session-secret-id/,
      );

      assert.doesNotMatch(
        logLines[0],
        /user-secret-id/,
      );

      assert.doesNotMatch(
        logLines[0],
        /bearer-secret/,
      );
    } finally {
      console.error =
        originalError;
    }
  },
);
