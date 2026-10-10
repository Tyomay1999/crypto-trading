import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createApp } from "../dist/app.js";
import { parseRecoveryBody } from "../dist/auth/recovery-code-plugin.js";
import { redactSensitiveHttpTarget } from "../dist/security/http-log-redaction.js";
import { ApplicationState } from "../dist/runtime/application-state.js";

const recoveryPrefix = "/api/v1/auth/mfa/recovery-codes";

const recoveryCode = "2345-6789-ABCD-EFGH-JKLM-NPQR-STUV-WXYZ";

const healthy = {
  databaseReady: async () => true,
  authDatabaseReady: async () => true,
};

function jsonResponse(body, status = 200, cookies = []) {
  const headers = new Headers({
    "content-type": "application/json",
  });

  for (const cookie of cookies) {
    headers.append("set-cookie", cookie);
  }

  return new Response(JSON.stringify(body), { status, headers });
}

const uniqueCharacters = ["A", "B", "C", "D", "E", "F", "G", "H", "J", "K"];

async function withRecoveryServer(overrides, run) {
  const calls = [];
  const auth = {
    handler: async () => new Response("Not Found", { status: 404 }),
    api: {
      deltaRecoveryStatus:
        overrides.status ??
        (async (input) => {
          calls.push({ operation: "status", input });
          return jsonResponse({
            configured: true,
            remaining: 7,
          });
        }),
      deltaRecoveryGenerate:
        overrides.generate ??
        (async (input) => {
          calls.push({ operation: "generate", input });
          return jsonResponse({
            codes: Array.from({ length: 10 }, (_, index) =>
              recoveryCode.replace("2345", `234${uniqueCharacters[index]}`),
            ),
          });
        }),
      deltaRecoveryRegenerate:
        overrides.regenerate ??
        (async (input) => {
          calls.push({ operation: "regenerate", input });
          return jsonResponse({
            codes: Array.from({ length: 10 }, (_, index) =>
              recoveryCode.replace("2345", `235${uniqueCharacters[index]}`),
            ),
          });
        }),
      deltaRecoveryVerify:
        overrides.verify ??
        (async (input) => {
          calls.push({ operation: "verify", input });
          return jsonResponse({ status: true }, 200, [
            "delta-auth.session_token=signed; Path=/; HttpOnly; SameSite=Lax",
            "delta-auth.two_factor=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax",
          ]);
        }),
    },
  };

  const database = {
    async query(sql, values = []) {
      calls.push({ operation: "rate", sql, values });
      return {
        rowCount: /RETURNING id/.test(sql) ? (overrides.rateRowCount ?? 1) : 0,
        rows: [],
      };
    },
  };

  const app = createApp(
    new ApplicationState(),
    healthy,
    auth,
    undefined,
    undefined,
    {
      database,
      trustedOrigins: ["https://delta.example"],
      recoveryPepper: "recovery-route-pepper-01234567890123456789",
    },
  );

  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    await run(`http://127.0.0.1:${address.port}`, calls);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

function recoveryHeaders(origin = "https://delta.example") {
  return {
    "content-type": "application/json",
    "x-real-ip": "203.0.113.8",
    origin,
  };
}

function assertPrivateResponse(response) {
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("pragma"), "no-cache");
}

test("exact public recovery routes return only their allowlisted response fields", async () => {
  await withRecoveryServer({}, async (baseUrl) => {
    const status = await fetch(baseUrl + recoveryPrefix + "/status", {
      headers: {
        "x-real-ip": "203.0.113.8",
      },
    });
    assert.equal(status.status, 200);
    assert.deepEqual(await status.json(), {
      configured: true,
      remaining: 7,
    });
    assertPrivateResponse(status);

    for (const operation of ["generate", "regenerate"]) {
      const response = await fetch(`${baseUrl}${recoveryPrefix}/${operation}`, {
        method: "POST",
        headers: recoveryHeaders(),
        body: JSON.stringify({
          password: "current password",
          code: "123456",
        }),
      });
      assert.equal(response.status, 200);
      const payload = await response.json();
      assert.deepEqual(Object.keys(payload), ["codes"]);
      assert.equal(payload.codes.length, 10);
      assertPrivateResponse(response);
    }

    const verified = await fetch(
      baseUrl + recoveryPrefix + "/challenge/verify",
      {
        method: "POST",
        headers: recoveryHeaders(),
        body: JSON.stringify({
          code: recoveryCode,
        }),
      },
    );
    assert.equal(verified.status, 200);
    assert.deepEqual(await verified.json(), { status: true });
    assert.equal(
      verified.headers
        .getSetCookie()
        .some((value) => value.startsWith("delta-auth.session_token=")),
      true,
    );
    assertPrivateResponse(verified);
  });
});

test("origin, rate, malformed, oversized, auth and unexpected failures are private and cookie-free", async () => {
  const authenticatedCookie =
    "delta-auth.session_token=must-not-leak; Path=/; HttpOnly";

  await withRecoveryServer(
    {
      status: async () =>
        jsonResponse({ internal: true }, 500, [authenticatedCookie]),
    },
    async (baseUrl) => {
      const requests = [
        fetch(baseUrl + recoveryPrefix + "/generate", {
          method: "POST",
          headers: recoveryHeaders("https://attacker.example"),
          body: "{}",
        }),
        fetch(baseUrl + recoveryPrefix + "/generate", {
          method: "POST",
          headers: recoveryHeaders(),
          body: "{",
        }),
        fetch(baseUrl + recoveryPrefix + "/generate", {
          method: "POST",
          headers: recoveryHeaders(),
          body: JSON.stringify({
            padding: "x".repeat(3_000),
          }),
        }),
        fetch(baseUrl + recoveryPrefix + "/status", {
          headers: {
            "x-real-ip": "203.0.113.8",
          },
        }),
        fetch(baseUrl + recoveryPrefix + "/sentinel-recovery-code", {
          headers: {
            "x-real-ip": "203.0.113.8",
          },
        }),
      ];

      for (const pending of requests) {
        const response = await pending;
        assert.ok(response.status >= 400);
        assertPrivateResponse(response);
        assert.equal(
          response.headers
            .getSetCookie()
            .some((value) => /session_token=[^;]/.test(value)),
          false,
        );

        const payload = await response.json();
        assert.deepEqual(Object.keys(payload), ["error"]);
        assert.equal(JSON.stringify(payload).includes("must-not-leak"), false);
      }
    },
  );
});

test("challenge rejection is generic across every recovery credential state", async () => {
  for (const status of [400, 401, 409]) {
    await withRecoveryServer(
      {
        verify: async () =>
          jsonResponse(
            {
              detail: `private-${status}`,
            },
            status,
          ),
      },
      async (baseUrl) => {
        const response = await fetch(
          baseUrl + recoveryPrefix + "/challenge/verify",
          {
            method: "POST",
            headers: recoveryHeaders(),
            body: JSON.stringify({
              code: recoveryCode,
            }),
          },
        );
        const payload = await response.json();
        assert.equal(
          payload.error.message,
          "Recovery request could not be completed.",
        );
        assert.equal(
          JSON.stringify(payload).includes(`private-${status}`),
          false,
        );
        assertPrivateResponse(response);
      },
    );
  }
});

test("active recovery account lock is a private HTTP 429", async () => {
  await withRecoveryServer(
    {
      verify: async () => jsonResponse({ detail: "private-account-lock" }, 429),
    },
    async (baseUrl) => {
      const response = await fetch(
        baseUrl + recoveryPrefix + "/challenge/verify",
        {
          method: "POST",
          headers: recoveryHeaders(),
          body: JSON.stringify({ code: recoveryCode }),
        },
      );
      assert.equal(response.status, 429);
      assert.deepEqual(response.headers.getSetCookie(), []);
      const payload = await response.json();
      assert.equal(payload.error.code, "RECOVERY_RATE_LIMITED");
      assert.equal(
        JSON.stringify(payload).includes("private-account-lock"),
        false,
      );
      assertPrivateResponse(response);
    },
  );
});

test("route rate-limit rejection is private, cookie-free and occurs before auth work", async () => {
  await withRecoveryServer(
    {
      rateRowCount: 0,
    },
    async (baseUrl, calls) => {
      const response = await fetch(
        baseUrl + recoveryPrefix + "/challenge/verify",
        {
          method: "POST",
          headers: recoveryHeaders(),
          body: JSON.stringify({
            code: recoveryCode,
          }),
        },
      );

      assert.equal(response.status, 429);
      assertPrivateResponse(response);
      assert.deepEqual(response.headers.getSetCookie(), []);
      assert.equal(
        calls.some((call) => call.operation === "verify"),
        false,
      );
    },
  );
});

test("request bodies are strict and cannot substitute recovery proof for management proof", () => {
  assert.deepEqual(
    parseRecoveryBody(
      {
        password: "current password",
        code: "123456",
      },
      true,
    ),
    {
      password: "current password",
      code: "123456",
    },
  );

  for (const body of [
    { code: recoveryCode },
    { password: "current", code: recoveryCode },
    { password: "current", code: "123456", generation: "client" },
  ]) {
    assert.throws(() => parseRecoveryBody(body, true));
  }

  assert.deepEqual(parseRecoveryBody({ code: recoveryCode }, false), {
    code: recoveryCode,
    password: "",
  });
  assert.throws(() =>
    parseRecoveryBody(
      {
        code: recoveryCode,
        trustDevice: true,
      },
      false,
    ),
  );
});

test("recovery path logging removes arbitrary suffixes and source keeps prefix middleware before JSON parsing", () => {
  const sentinel = "sentinel-recovery-code";
  const redacted = redactSensitiveHttpTarget(`${recoveryPrefix}/${sentinel}`);

  assert.equal(redacted.includes(sentinel), false);

  const appSource = readFileSync("src/app.ts", "utf8");
  assert.ok(
    appSource.indexOf("recoverySensitiveHeaders") <
      appSource.indexOf("express.json"),
  );
  assert.match(
    appSource,
    /RECOVERY_PREFIX,\s*express\.json\(\{ limit: "2kb" \}\)/,
  );
});
