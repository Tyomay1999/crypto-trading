import assert from "node:assert/strict";
import test from "node:test";

import {
  createDevControlServer,
  listenDevControlServer,
} from "../dist/dev-simulator/server.js";

class FakeController {
  records = new Map();

  list() {
    return [...this.records.values()];
  }

  async publish(signalId, projection) {
    if (this.records.has(signalId)) {
      throw new Error(`DEV signal already exists: ${signalId}`);
    }
    const record = {
      signalId,
      projection,
      state: "PUBLISHED",
      sequence: 0,
      terminal: false,
      entryReachedAt: null,
    };
    this.records.set(signalId, record);
    return structuredClone(record);
  }

  async next(signalId) {
    const record = this.records.get(signalId);
    if (!record) throw new Error(`Unknown DEV signal: ${signalId}`);
    if (record.terminal) throw new Error(`Signal ${signalId} is terminal.`);
    const next = {
      ...record,
      state: "WAITING_FOR_ENTRY",
      sequence: record.sequence + 1,
    };
    this.records.set(signalId, next);
    return structuredClone(next);
  }

  async stop(signalId) {
    const record = this.records.get(signalId);
    if (!record) throw new Error(`Unknown DEV signal: ${signalId}`);
    if (record.state !== "ENTRY_REACHED") {
      throw new Error(`STOP is not allowed from ${record.state}.`);
    }
    const stopped = {
      ...record,
      state: "STOP_REACHED",
      sequence: record.sequence + 1,
      terminal: true,
    };
    this.records.set(signalId, stopped);
    return structuredClone(stopped);
  }
}

async function withServer(run) {
  const controller = new FakeController();
  const server = createDevControlServer(controller, {
    host: "127.0.0.1",
    port: 0,
  });
  const address = await listenDevControlServer(server, {
    host: "127.0.0.1",
    port: 0,
  });

  try {
    await run({
      controller,
      baseUrl: `http://127.0.0.1:${address.port}`,
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("control server refuses non-loopback bind", () => {
  assert.throws(
    () =>
      createDevControlServer(new FakeController(), {
        host: "0.0.0.0",
        port: 3900,
      }),
    /loopback only/,
  );
});

test("GET /status exposes only DEV control state", async () => {
  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/status`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), {
      status: "ok",
      signals: [],
    });
  });
});

test("POST /signals creates a demo projection with strict body", async () => {
  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/signals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        signalId: "dev-http-btc",
        symbol: "BTCUSDT",
        direction: "LONG",
      }),
    });

    assert.equal(response.status, 201);
    const body = await response.json();
    assert.equal(body.signal.signalId, "dev-http-btc");
    assert.equal(body.signal.state, "PUBLISHED");
    assert.equal(body.signal.projection.tradePlan.entry.referencePrice, "118500");
  });
});

test("duplicate create is mapped to finite 409 error", async () => {
  await withServer(async ({ baseUrl }) => {
    const request = () =>
      fetch(`${baseUrl}/signals`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ signalId: "dup-http" }),
      });

    assert.equal((await request()).status, 201);
    const duplicate = await request();
    assert.equal(duplicate.status, 409);
    assert.deepEqual(await duplicate.json(), {
      error: { code: "signal_already_exists" },
    });
  });
});

test("POST /signals/:id/next advances existing signal", async () => {
  await withServer(async ({ baseUrl }) => {
    await fetch(`${baseUrl}/signals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ signalId: "next-http" }),
    });

    const response = await fetch(`${baseUrl}/signals/next-http/next`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.signal.state, "WAITING_FOR_ENTRY");
  });
});

test("invalid STOP remains fail-closed as finite 409", async () => {
  await withServer(async ({ baseUrl }) => {
    await fetch(`${baseUrl}/signals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ signalId: "stop-http" }),
    });

    const response = await fetch(`${baseUrl}/signals/stop-http/stop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: { code: "transition_not_allowed" },
    });
  });
});

test("unknown signal and unknown route are distinct finite 404s", async () => {
  await withServer(async ({ baseUrl }) => {
    const missingSignal = await fetch(`${baseUrl}/signals/missing/next`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(missingSignal.status, 404);
    assert.deepEqual(await missingSignal.json(), {
      error: { code: "signal_not_found" },
    });

    const missingRoute = await fetch(`${baseUrl}/reset`, { method: "POST" });
    assert.equal(missingRoute.status, 404);
    assert.deepEqual(await missingRoute.json(), {
      error: { code: "not_found" },
    });
  });
});

test("control body parser rejects malformed, unexpected, and oversized input", async () => {
  await withServer(async ({ baseUrl }) => {
    const malformed = await fetch(`${baseUrl}/signals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    assert.equal(malformed.status, 400);

    const unexpected = await fetch(`${baseUrl}/signals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        signalId: "unexpected",
        extra: true,
      }),
    });
    assert.equal(unexpected.status, 400);

    const oversized = await fetch(`${baseUrl}/signals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        signalId: "large",
        extraPadding: "x".repeat(20 * 1024),
      }),
    });
    assert.equal(oversized.status, 413);
  });
});
