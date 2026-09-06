import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

import express from "express";

import {
  errorHandlerMiddleware,
} from "../dist/middleware/error-handler.js";

import {
  requestContextMiddleware,
} from "../dist/middleware/request-context.js";

import {
  createSessionRouter,
} from "../dist/routes/session.routes.js";

function sessionResponse(
  {
    sessionId =
      "session-current",
    userId =
      "user-a",
  } = {},
) {
  return new Response(
    JSON.stringify({
      session: {
        id:
          sessionId,
        userId,
        token:
          "current-secret-token",
      },
      user: {
        id:
          userId,
      },
    }),
    {
      status: 200,
    },
  );
}

function nullSessionResponse() {
  return new Response(
    "null",
    {
      status: 200,
    },
  );
}

function mutationResponse(
  {
    setCookie,
  } = {},
) {
  const headers =
    new Headers();

  if (setCookie) {
    headers.append(
      "Set-Cookie",
      setCookie,
    );
  }

  return new Response(
    JSON.stringify({
      status: true,
    }),
    {
      status: 200,
      headers,
    },
  );
}

function createAuthMock(
  overrides = {},
) {
  const calls = [];

  const api = {
    getSession:
      async () =>
        sessionResponse(),

    revokeSession:
      async (options) => {
        calls.push({
          operation:
            "revokeSession",
          options,
        });

        return mutationResponse();
      },

    revokeSessions:
      async (options) => {
        calls.push({
          operation:
            "revokeSessions",
          options,
        });

        return mutationResponse();
      },

    signOut:
      async (options) => {
        calls.push({
          operation:
            "signOut",
          options,
        });

        return mutationResponse({
          setCookie:
            "delta-auth.session_token=; Max-Age=0; Path=/; HttpOnly",
        });
      },

    ...overrides,
  };

  return {
    auth: {
      api,
    },

    calls,
  };
}

function createDatabaseMock(
  {
    credentialToken =
      "target-secret-token",
    includeCurrent = true,
  } = {},
) {
  return {
    query:
      async (
        sql,
        _parameters,
      ) => {
        if (
          /AS\s+session_id/i.test(
            sql,
          )
        ) {
          const rows = [];

          if (includeCurrent) {
            rows.push({
              session_id:
                "session-current",
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
                "Mozilla/5.0 (Windows NT 10.0) Chrome/151.0.0.0 Safari/537.36",
              last_activity_at:
                new Date(
                  "2026-09-06T18:30:00.000Z",
                ),
            });
          }

          rows.push({
            session_id:
              "session-other",
            created_at:
              new Date(
                "2026-09-06T17:00:00.000Z",
              ),
            expires_at:
              new Date(
                "2026-09-13T17:00:00.000Z",
              ),
            ip_address:
              "198.51.100.99",
            user_agent:
              "Mozilla/5.0 (iPhone) Version/19.0 Mobile Safari/604.1",
            last_activity_at:
              new Date(
                "2026-09-06T17:30:00.000Z",
              ),
          });

          return {
            rowCount:
              rows.length,
            rows,
          };
        }

        if (
          /AS\s+token/i.test(
            sql,
          )
        ) {
          if (
            credentialToken ===
            null
          ) {
            return {
              rowCount: 0,
              rows: [],
            };
          }

          return {
            rowCount: 1,
            rows: [
              {
                token:
                  credentialToken,
              },
            ],
          };
        }

        throw new Error(
          `Unexpected SQL: ${sql}`,
        );
      },
  };
}

async function withServer(
  dependencies,
  run,
) {
  const app =
    express();

  app.use(
    requestContextMiddleware,
  );

  app.use(
    express.json(),
  );

  app.use(
    "/api/v1/auth/sessions",
    createSessionRouter(
      dependencies,
    ),
  );

  app.use(
    errorHandlerMiddleware,
  );

  const server =
    app.listen(
      0,
      "127.0.0.1",
    );

  await once(
    server,
    "listening",
  );

  const address =
    server.address();

  if (
    address === null ||
    typeof address ===
      "string"
  ) {
    throw new Error(
      "Unable to resolve test server.",
    );
  }

  try {
    await run(
      `http://127.0.0.1:${address.port}`,
    );
  } finally {
    await new Promise(
      (
        resolve,
        reject,
      ) => {
        server.close(
          (error) => {
            if (error) {
              reject(error);
              return;
            }

            resolve();
          },
        );
      },
    );
  }
}

function dependencies(
  auth,
  database,
) {
  return {
    auth,
    database,

    trustedOrigins: [
      "https://app.delta.test",
    ],

    observeActivity:
      async () => {},

    now:
      () =>
        new Date(
          "2026-09-06T19:00:00.000Z",
        ),
  };
}

test(
  "GET sessions returns sanitized active sessions with exactly one current device",
  async () => {
    const {
      auth,
    } =
      createAuthMock();

    const database =
      createDatabaseMock();

    await withServer(
      dependencies(
        auth,
        database,
      ),
      async (baseUrl) => {
        const response =
          await fetch(
            `${baseUrl}/api/v1/auth/sessions`,
          );

        assert.equal(
          response.status,
          200,
        );

        assert.equal(
          response.headers.get(
            "cache-control",
          ),
          "no-store",
        );

        assert.equal(
          response.headers.get(
            "pragma",
          ),
          "no-cache",
        );

        const payload =
          await response.json();

        assert.equal(
          payload.sessions.length,
          2,
        );

        assert.equal(
          payload.sessions.filter(
            (session) =>
              session.current,
          ).length,
          1,
        );

        const serialized =
          JSON.stringify(
            payload,
          );

        assert.doesNotMatch(
          serialized,
          /secret-token/,
        );

        assert.doesNotMatch(
          serialized,
          /203\.0\.113\.42/,
        );

        assert.doesNotMatch(
          serialized,
          /198\.51\.100\.99/,
        );
      },
    );
  },
);

test(
  "GET sessions rejects an absent Better Auth session",
  async () => {
    const {
      auth,
    } =
      createAuthMock({
        getSession:
          async () =>
            nullSessionResponse(),
      });

    await withServer(
      dependencies(
        auth,
        createDatabaseMock(),
      ),
      async (baseUrl) => {
        const response =
          await fetch(
            `${baseUrl}/api/v1/auth/sessions`,
          );

        assert.equal(
          response.status,
          401,
        );

        const payload =
          await response.json();

        assert.equal(
          payload.error.code,
          "AUTHENTICATION_REQUIRED",
        );
      },
    );
  },
);

test(
  "session mutation rejects missing Origin or Referer",
  async () => {
    const {
      auth,
      calls,
    } =
      createAuthMock();

    await withServer(
      dependencies(
        auth,
        createDatabaseMock(),
      ),
      async (baseUrl) => {
        const response =
          await fetch(
            `${baseUrl}/api/v1/auth/sessions/revoke`,
            {
              method: "POST",
              headers: {
                "content-type":
                  "application/json",
              },
              body:
                JSON.stringify({
                  sessionId:
                    "session-other",
                }),
            },
          );

        assert.equal(
          response.status,
          403,
        );

        const payload =
          await response.json();

        assert.equal(
          payload.error.code,
          "TRUSTED_ORIGIN_REQUIRED",
        );

        assert.equal(
          calls.length,
          0,
        );
      },
    );
  },
);

test(
  "session mutation rejects untrusted Origin",
  async () => {
    const {
      auth,
    } =
      createAuthMock();

    await withServer(
      dependencies(
        auth,
        createDatabaseMock(),
      ),
      async (baseUrl) => {
        const response =
          await fetch(
            `${baseUrl}/api/v1/auth/sessions/revoke`,
            {
              method: "POST",
              headers: {
                "content-type":
                  "application/json",
                origin:
                  "https://evil.example",
              },
              body:
                JSON.stringify({
                  sessionId:
                    "session-other",
                }),
            },
          );

        assert.equal(
          response.status,
          403,
        );

        const payload =
          await response.json();

        assert.equal(
          payload.error.code,
          "UNTRUSTED_ORIGIN",
        );
      },
    );
  },
);

test(
  "revoke refuses current session",
  async () => {
    const {
      auth,
      calls,
    } =
      createAuthMock();

    await withServer(
      dependencies(
        auth,
        createDatabaseMock(),
      ),
      async (baseUrl) => {
        const response =
          await fetch(
            `${baseUrl}/api/v1/auth/sessions/revoke`,
            {
              method: "POST",
              headers: {
                "content-type":
                  "application/json",
                origin:
                  "https://app.delta.test",
              },
              body:
                JSON.stringify({
                  sessionId:
                    "session-current",
                }),
            },
          );

        assert.equal(
          response.status,
          409,
        );

        const payload =
          await response.json();

        assert.equal(
          payload.error.code,
          "CURRENT_SESSION_REQUIRES_LOGOUT",
        );

        assert.equal(
          calls.length,
          0,
        );
      },
    );
  },
);

test(
  "revoke hides missing and foreign session distinction",
  async () => {
    const {
      auth,
    } =
      createAuthMock();

    await withServer(
      dependencies(
        auth,
        createDatabaseMock({
          credentialToken:
            null,
        }),
      ),
      async (baseUrl) => {
        const response =
          await fetch(
            `${baseUrl}/api/v1/auth/sessions/revoke`,
            {
              method: "POST",
              headers: {
                "content-type":
                  "application/json",
                origin:
                  "https://app.delta.test",
              },
              body:
                JSON.stringify({
                  sessionId:
                    "unknown-session",
                }),
            },
          );

        assert.equal(
          response.status,
          404,
        );

        const payload =
          await response.json();

        assert.equal(
          payload.error.code,
          "SESSION_NOT_FOUND",
        );
      },
    );
  },
);

test(
  "revoke another session uses server-only token",
  async () => {
    const {
      auth,
      calls,
    } =
      createAuthMock();

    await withServer(
      dependencies(
        auth,
        createDatabaseMock({
          credentialToken:
            "other-server-secret",
        }),
      ),
      async (baseUrl) => {
        const response =
          await fetch(
            `${baseUrl}/api/v1/auth/sessions/revoke`,
            {
              method: "POST",
              headers: {
                "content-type":
                  "application/json",
                origin:
                  "https://app.delta.test",
              },
              body:
                JSON.stringify({
                  sessionId:
                    "session-other",
                }),
            },
          );

        assert.equal(
          response.status,
          204,
        );

        assert.equal(
          await response.text(),
          "",
        );

        assert.equal(
          calls.length,
          1,
        );

        assert.equal(
          calls[0].operation,
          "revokeSession",
        );

        assert.equal(
          calls[0].options.body.token,
          "other-server-secret",
        );
      },
    );
  },
);

test(
  "logout-current revokes durable session before cookie clear",
  async () => {
    const {
      auth,
      calls,
    } =
      createAuthMock();

    await withServer(
      dependencies(
        auth,
        createDatabaseMock({
          credentialToken:
            "current-server-secret",
        }),
      ),
      async (baseUrl) => {
        const response =
          await fetch(
            `${baseUrl}/api/v1/auth/sessions/logout-current`,
            {
              method: "POST",
              headers: {
                origin:
                  "https://app.delta.test",
              },
            },
          );

        assert.equal(
          response.status,
          204,
        );

        assert.deepEqual(
          calls.map(
            (call) =>
              call.operation,
          ),
          [
            "revokeSession",
            "signOut",
          ],
        );

        assert.equal(
          calls[0].options.body.token,
          "current-server-secret",
        );

        assert.ok(
          response.headers
            .getSetCookie()
            .some(
              (cookie) =>
                cookie.includes(
                  "Max-Age=0",
                ),
            ),
        );
      },
    );
  },
);

test(
  "logout-everywhere revokes all sessions before cookie clear",
  async () => {
    const {
      auth,
      calls,
    } =
      createAuthMock();

    await withServer(
      dependencies(
        auth,
        createDatabaseMock(),
      ),
      async (baseUrl) => {
        const response =
          await fetch(
            `${baseUrl}/api/v1/auth/sessions/logout-everywhere`,
            {
              method: "POST",
              headers: {
                referer:
                  "https://app.delta.test/security/sessions",
              },
            },
          );

        assert.equal(
          response.status,
          204,
        );

        assert.deepEqual(
          calls.map(
            (call) =>
              call.operation,
          ),
          [
            "revokeSessions",
            "signOut",
          ],
        );
      },
    );
  },
);

test(
  "session listing fails closed if current session disappears during inventory race",
  async () => {
    const {
      auth,
    } =
      createAuthMock();

    await withServer(
      dependencies(
        auth,
        createDatabaseMock({
          includeCurrent:
            false,
        }),
      ),
      async (baseUrl) => {
        const response =
          await fetch(
            `${baseUrl}/api/v1/auth/sessions`,
          );

        assert.equal(
          response.status,
          401,
        );

        const payload =
          await response.json();

        assert.equal(
          payload.error.code,
          "AUTHENTICATION_REQUIRED",
        );
      },
    );
  },
);


test(
  "revoke rejects bodies with additional fields",
  async () => {
    const {
      auth,
      calls,
    } =
      createAuthMock();

    await withServer(
      dependencies(
        auth,
        createDatabaseMock(),
      ),
      async (baseUrl) => {
        const response =
          await fetch(
            `${baseUrl}/api/v1/auth/sessions/revoke`,
            {
              method: "POST",
              headers: {
                "content-type":
                  "application/json",
                origin:
                  "https://app.delta.test",
              },
              body:
                JSON.stringify({
                  sessionId:
                    "session-other",
                  unexpected:
                    true,
                }),
            },
          );

        assert.equal(
          response.status,
          400,
        );

        const payload =
          await response.json();

        assert.equal(
          payload.error.code,
          "INVALID_SESSION_ID",
        );

        assert.equal(
          calls.length,
          0,
        );
      },
    );
  },
);

test(
  "Origin header rejects path and credential-bearing variants of a trusted host",
  async () => {
    for (
      const origin of [
        "https://app.delta.test/forged",
        "https://user:pass@app.delta.test",
      ]
    ) {
      const {
        auth,
        calls,
      } =
        createAuthMock();

      await withServer(
        dependencies(
          auth,
          createDatabaseMock(),
        ),
        async (baseUrl) => {
          const response =
            await fetch(
              `${baseUrl}/api/v1/auth/sessions/revoke`,
              {
                method: "POST",
                headers: {
                  "content-type":
                    "application/json",
                  origin,
                },
                body:
                  JSON.stringify({
                    sessionId:
                      "session-other",
                  }),
              },
            );

          assert.equal(
            response.status,
            403,
          );

          assert.equal(
            calls.length,
            0,
          );
        },
      );
    }
  },
);
