import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

import { createApp } from "../dist/app.js";

async function withServer(run) {
  const app = createApp();
  const server = app.listen(0, "127.0.0.1");

  await once(server, "listening");

  const address = server.address();

  if (address === null || typeof address === "string") {
    throw new Error("Unable to resolve test server address");
  }

  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }
}

test("GET /health returns healthy backend contract", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health`);

    assert.equal(response.status, 200);

    const requestId = response.headers.get("x-request-id");

    assert.ok(requestId);

    const payload = await response.json();

    assert.equal(payload.status, "ok");
    assert.equal(payload.service, "delta-backend");
    assert.equal(payload.version, "v1");
    assert.equal(typeof payload.timestamp, "string");
  });
});

test("GET /api/v1/health preserves caller request ID", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/health`, {
      headers: {
        "x-request-id": "delta-test-request-001",
      },
    });

    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("x-request-id"),
      "delta-test-request-001",
    );
  });
});

test("invalid caller request ID is replaced", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health`, {
      headers: {
        "x-request-id": "invalid request id with spaces",
      },
    });

    assert.equal(response.status, 200);

    const requestId = response.headers.get("x-request-id");

    assert.ok(requestId);
    assert.notEqual(
      requestId,
      "invalid request id with spaces",
    );
  });
});

test("unknown route returns canonical 404 error contract", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/missing-route`, {
      headers: {
        "x-request-id": "delta-test-404",
      },
    });

    assert.equal(response.status, 404);

    const payload = await response.json();

    assert.deepEqual(payload, {
      error: {
        code: "ROUTE_NOT_FOUND",
        message: "The requested API route does not exist.",
        requestId: "delta-test-404",
      },
    });
  });
});

test("invalid JSON returns canonical 400 error contract", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/health`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-request-id": "delta-test-invalid-json",
      },
      body: "{",
    });

    assert.equal(response.status, 400);

    const payload = await response.json();

    assert.deepEqual(payload, {
      error: {
        code: "INVALID_JSON",
        message: "Request body contains invalid JSON.",
        requestId: "delta-test-invalid-json",
      },
    });
  });
});
