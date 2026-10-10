import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync("src/auth/passkey-plugin.ts", "utf8");

class FakePasskeyCeremonyError extends Error {
  constructor(code) {
    super("Passkey ceremony rejected.");
    this.code = code;
  }
}

function counterFromDatabase(value) {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,9})$/.test(value)) {
    throw new Error("invalid counter");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 4294967295) {
    throw new Error("invalid counter");
  }
  return parsed;
}

function counterToDatabase(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 4294967295) {
    throw new Error("invalid counter");
  }
  return String(value);
}

const exportsObject = {};
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: "passkey-plugin.ts",
}).outputText;

vm.runInNewContext(compiled, {
  exports: exportsObject,
  module: { exports: exportsObject },
  Object,
  Set,
  Error,
  Date,
  Number,
  require(specifier) {
    if (specifier === "@better-auth/core/context") {
      return {
        getCurrentAdapter: async (adapter) => adapter,
        runWithTransaction: async (_adapter, fn) => fn(),
      };
    }
    if (specifier === "better-auth/cookies") {
      return { setSessionCookie: async () => undefined };
    }
    if (specifier === "./passkey-ceremony.js") {
      return {
        PasskeyCeremonyError: FakePasskeyCeremonyError,
        passkeyCeremonyServices: {
          verifyAuthentication: async () => {
            throw new Error("production dependency not used by unit test");
          },
        },
      };
    }
    if (specifier === "./passkey-challenge.js") {
      return { clearPasskeyLookupCookie: () => undefined };
    }
    if (specifier === "./passkey-counter.js") {
      return {
        passkeyCounterFromDatabase: counterFromDatabase,
        passkeyCounterToDatabase: counterToDatabase,
      };
    }
    if (specifier === "../storage/passkey-session-marker.js") {
      return { insertPasskeySessionMarker: async () => undefined };
    }
    throw new Error(`Unexpected test import: ${specifier}`);
  },
});

const {
  PasskeyAuthenticationFailure,
  createPasskeyAuthenticationOrchestrator,
  validatePasskeyCounterTransition,
} = exportsObject;

const config = Object.freeze({
  rpId: "example.test",
  rpName: "Delta",
  origin: "https://example.test",
  userVerification: "required",
  attestation: "none",
  residentKey: "preferred",
  requireResidentKey: false,
  requireUserPresence: true,
});

function fixture(overrides = {}) {
  const events = [];
  let inTransaction = false;
  const baseAdapter = { name: "base" };
  const txAdapter = {
    name: "transaction",
    async findOne(query) {
      if (query.model === "passkey") {
        events.push("COUNTER_READ");
        return {
          id: "passkey-server-owned",
          userId: "user-server-owned",
          counter: overrides.storedCounter ?? 1,
        };
      }
      if (query.model === "user") {
        events.push("USER_READ");
        return {
          id: "user-server-owned",
          email: "synthetic@example.test",
          emailVerified: true,
          name: "Synthetic",
          image: null,
          createdAt: new Date(0),
          updatedAt: new Date(0),
        };
      }
      throw new Error("unexpected model");
    },
    async incrementOne(query) {
      events.push("COUNTER_CAS");
      if (overrides.casFailure) return null;
      return {
        id: "passkey-server-owned",
        userId: "user-server-owned",
        counter: query.set.counter,
      };
    },
  };

  const context = {
    context: {
      internalAdapter: {
        async createSession(userId) {
          assert.equal(inTransaction, true);
          events.push("SESSION_CREATE");
          if (overrides.sessionFailure) throw new Error("synthetic session failure");
          assert.equal(userId, "user-server-owned");
          return {
            id: "session-server-created",
            token: "synthetic-session-token-never-returned",
            userId,
            expiresAt: new Date(60_000),
            createdAt: new Date(0),
            updatedAt: new Date(0),
            ipAddress: "",
            userAgent: "",
          };
        },
      },
    },
  };

  const expectedCas = [];
  const orchestrator = createPasskeyAuthenticationOrchestrator({
    async runTransaction(adapter, callback) {
      assert.equal(adapter, baseAdapter);
      events.push("TX_BEGIN");
      inTransaction = true;
      try {
        const result = await callback();
        events.push("TX_CALLBACK_RETURN");
        if (overrides.commitFailure) {
          events.push("TX_COMMIT_FAILURE");
          throw new Error("synthetic commit failure");
        }
        events.push("TX_COMMIT");
        return result;
      } catch (error) {
        events.push("TX_ROLLBACK");
        throw error;
      } finally {
        inTransaction = false;
      }
    },
    async currentAdapter(adapter) {
      assert.equal(adapter, baseAdapter);
      assert.equal(inTransaction, true);
      return txAdapter;
    },
    async verifyAuthentication(input) {
      assert.equal(inTransaction, true);
      assert.equal(input.adapter, txAdapter);
      events.push("CHALLENGE_CONSUME");
      if (overrides.verifyError) {
        events.push(
          overrides.verifyError instanceof FakePasskeyCeremonyError
            ? "WEBAUTHN_VERIFY_REJECTED_EXPECTED"
            : "WEBAUTHN_VERIFY_FAILED_UNKNOWN",
        );
        throw overrides.verifyError;
      }
      events.push("WEBAUTHN_VERIFY");
      return Object.freeze({
        passkeyId: "passkey-server-owned",
        userId: "user-server-owned",
        newCounter: overrides.newCounter ?? 2,
        userVerified: true,
        credentialDeviceType: "multiDevice",
        credentialBackedUp: true,
        aaguid: "synthetic-aaguid",
        transports: "internal",
      });
    },
    async insertProvenance(adapter, marker) {
      assert.equal(inTransaction, true);
      assert.equal(adapter, txAdapter);
      events.push("PROVENANCE_INSERT");
      if (overrides.provenanceFailure) {
        throw new Error("synthetic provenance failure");
      }
      assert.deepEqual(
        {
          sessionId: marker.sessionId,
          passkeyId: marker.passkeyId,
          userVerified: marker.userVerified,
          credentialDeviceType: marker.credentialDeviceType,
          credentialBackedUp: marker.credentialBackedUp,
          aaguid: marker.aaguid,
          transports: marker.transports,
          authenticatedAt: marker.authenticatedAt.toISOString(),
        },
        {
          sessionId: "session-server-created",
          passkeyId: "passkey-server-owned",
          userVerified: true,
          credentialDeviceType: "multiDevice",
          credentialBackedUp: true,
          aaguid: "synthetic-aaguid",
          transports: "internal",
          authenticatedAt: "2026-09-11T00:00:00.000Z",
        },
      );
    },
    async setAuthCookie(_context, pair) {
      assert.equal(inTransaction, false);
      events.push("SET_AUTH_COOKIE");
      assert.equal(pair.user.id, "user-server-owned");
      assert.equal(pair.session.userId, "user-server-owned");
      if (overrides.cookieFailure) throw new Error("synthetic cookie failure");
    },
    clearLookupCookie() {
      assert.equal(inTransaction, false);
      events.push("CLEAR_LOOKUP_COOKIE");
    },
    now: () => new Date("2026-09-11T00:00:00.000Z"),
    ...(overrides.bindTestTransactionSelector === undefined
      ? {}
      : {
          async bindTestTransactionSelector(input) {
            assert.equal(inTransaction, true);
            assert.equal(input.adapter, txAdapter);
            assert.equal(input.context, context);
            events.push("SELECTOR_BIND");
            await overrides.bindTestTransactionSelector(input);
          },
        }),
  });

  const originalIncrement = txAdapter.incrementOne;
  txAdapter.incrementOne = async (query) => {
    expectedCas.push(query);
    return originalIncrement.call(txAdapter, query);
  };

  return {
    events,
    expectedCas,
    run: () =>
      orchestrator({
        adapter: baseAdapter,
        context,
        config,
        response: { id: "response-owned-credential" },
      }),
  };
}

test("success commits the authoritative transaction before releasing cookies", async () => {
  const state = fixture();
  assert.equal((await state.run()).status, "authenticated");
  assert.deepEqual(state.events, [
    "TX_BEGIN",
    "CHALLENGE_CONSUME",
    "WEBAUTHN_VERIFY",
    "COUNTER_READ",
    "COUNTER_CAS",
    "USER_READ",
    "SESSION_CREATE",
    "PROVENANCE_INSERT",
    "TX_CALLBACK_RETURN",
    "TX_COMMIT",
    "SET_AUTH_COOKIE",
    "CLEAR_LOOKUP_COOKIE",
  ]);
});

test("counterless zero-to-zero authentication performs no counter write", async () => {
  const state = fixture({ storedCounter: 0, newCounter: 0 });
  await state.run();
  assert.equal(state.events.includes("COUNTER_CAS"), false);
  assert.ok(state.events.indexOf("WEBAUTHN_VERIFY") < state.events.indexOf("SESSION_CREATE"));
  assert.ok(state.events.indexOf("TX_COMMIT") < state.events.indexOf("SET_AUTH_COOKIE"));
});

for (const [stored, next] of [
  [0, 1],
  [1, 2],
  [2147483648, 2147483649],
  [4294967294, 4294967295],
]) {
  test(`positive counter CAS uses exact id and ${stored} -> ${next} guard`, async () => {
    const state = fixture({ storedCounter: stored, newCounter: next });
    await state.run();
    assert.equal(state.expectedCas.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(state.expectedCas[0])), {
      model: "passkey",
      where: [
        { field: "id", value: "passkey-server-owned" },
        { field: "counter", value: stored },
      ],
      increment: {},
      set: { counter: next },
    });
  });
}

test("CAS conflict rolls back without session, provenance, or cookie mutation", async () => {
  const state = fixture({ casFailure: true });
  await assert.rejects(state.run(), (error) => error.code === "AUTHENTICATION_STATE_FAILURE");
  assert.ok(state.events.includes("TX_ROLLBACK"));
  for (const forbidden of ["SESSION_CREATE", "PROVENANCE_INSERT", "SET_AUTH_COOKIE", "CLEAR_LOOKUP_COOKIE"]) {
    assert.equal(state.events.includes(forbidden), false);
  }
});

test("known proof rejection commits challenge consumption and clears only lookup cookie", async () => {
  const state = fixture({
    verifyError: new FakePasskeyCeremonyError("AUTHENTICATION_REJECTED"),
  });
  assert.equal((await state.run()).status, "rejected");
  assert.deepEqual(state.events, [
    "TX_BEGIN",
    "CHALLENGE_CONSUME",
    "WEBAUTHN_VERIFY_REJECTED_EXPECTED",
    "TX_CALLBACK_RETURN",
    "TX_COMMIT",
    "CLEAR_LOOKUP_COOKIE",
  ]);
});

test("challenge rejection is narrowly committed while service errors roll back", async () => {
  const expected = fixture({
    verifyError: new FakePasskeyCeremonyError("CHALLENGE_REJECTED"),
  });
  assert.equal((await expected.run()).status, "rejected");
  const unavailable = fixture({
    verifyError: new FakePasskeyCeremonyError("SERVICE_UNAVAILABLE"),
  });
  await assert.rejects(unavailable.run());
  assert.ok(unavailable.events.includes("TX_ROLLBACK"));
  assert.equal(unavailable.events.includes("CLEAR_LOOKUP_COOKIE"), false);
});

test("unknown verifier failure rolls back and preserves lookup cookie", async () => {
  const state = fixture({ verifyError: new TypeError("synthetic invariant") });
  await assert.rejects(state.run(), (error) => error.code === "AUTHENTICATION_STATE_FAILURE");
  assert.ok(state.events.includes("TX_ROLLBACK"));
  assert.equal(state.events.includes("SET_AUTH_COOKIE"), false);
  assert.equal(state.events.includes("CLEAR_LOOKUP_COOKIE"), false);
});

test("session creation failure rolls back and emits no cookies", async () => {
  const state = fixture({ sessionFailure: true });
  await assert.rejects(state.run());
  assert.ok(state.events.includes("TX_ROLLBACK"));
  assert.equal(state.events.includes("PROVENANCE_INSERT"), false);
  assert.equal(state.events.includes("SET_AUTH_COOKIE"), false);
  assert.equal(state.events.includes("CLEAR_LOOKUP_COOKIE"), false);
});

test("provenance insertion failure rolls back session and counter contract", async () => {
  const state = fixture({ provenanceFailure: true });
  await assert.rejects(state.run());
  assert.ok(state.events.includes("SESSION_CREATE"));
  assert.ok(state.events.includes("PROVENANCE_INSERT"));
  assert.ok(state.events.includes("TX_ROLLBACK"));
  assert.equal(state.events.includes("SET_AUTH_COOKIE"), false);
  assert.equal(state.events.includes("CLEAR_LOOKUP_COOKIE"), false);
});

test("transaction commit failure cannot emit an authentication cookie", async () => {
  const state = fixture({ commitFailure: true });
  await assert.rejects(state.run());
  assert.ok(state.events.includes("TX_COMMIT_FAILURE"));
  assert.equal(state.events.includes("SET_AUTH_COOKIE"), false);
  assert.equal(state.events.includes("CLEAR_LOOKUP_COOKIE"), false);
});

test("post-commit cookie failure is distinct and never claims rollback", async () => {
  const state = fixture({ cookieFailure: true });
  await assert.rejects(
    state.run(),
    (error) => error.code === "POST_COMMIT_COOKIE_FAILURE",
  );
  assert.ok(state.events.includes("TX_COMMIT"));
  assert.ok(state.events.includes("SET_AUTH_COOKIE"));
  assert.equal(state.events.includes("TX_ROLLBACK"), false);
  assert.equal(state.events.includes("CLEAR_LOOKUP_COOKIE"), false);
});

for (const [stored, next] of [
  [1, 1],
  [2, 1],
  [1, 0],
  [0, 4294967296],
  [0, -1],
]) {
  test(`invalid counter transition ${stored} -> ${next} fails closed`, async () => {
    const state = fixture({ storedCounter: stored, newCounter: next });
    await assert.rejects(state.run());
    assert.ok(state.events.includes("TX_ROLLBACK"));
    assert.equal(state.events.includes("SESSION_CREATE"), false);
    assert.equal(state.events.includes("SET_AUTH_COOKIE"), false);
  });
}

test("counter transition helper preserves uint32 and counterless semantics", () => {
  assert.deepEqual(
    JSON.parse(JSON.stringify(validatePasskeyCounterTransition("0", 0))),
    {
    stored: 0,
    next: 0,
    requiresCas: false,
    },
  );
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(
        validatePasskeyCounterTransition("2147483648", 2147483649),
      ),
    ),
    {
    stored: 2147483648,
    next: 2147483649,
    requiresCas: true,
    },
  );
  assert.throws(() => validatePasskeyCounterTransition("01", 2));
});

test("test selector hook receives the exact transaction adapter before challenge consumption", async () => {
  const state = fixture({
    async bindTestTransactionSelector() {},
  });
  await state.run();
  assert.ok(state.events.indexOf("SELECTOR_BIND") > state.events.indexOf("TX_BEGIN"));
  assert.ok(
    state.events.indexOf("SELECTOR_BIND") <
      state.events.indexOf("CHALLENGE_CONSUME"),
  );
});

test("selector bind failure rolls back before challenge or credential mutation", async () => {
  const state = fixture({
    async bindTestTransactionSelector() {
      throw new Error("synthetic selector bind failure");
    },
  });
  await assert.rejects(
    state.run(),
    (error) => error.code === "AUTHENTICATION_STATE_FAILURE",
  );
  assert.ok(state.events.includes("TX_ROLLBACK"));
  assert.equal(state.events.includes("CHALLENGE_CONSUME"), false);
  assert.equal(state.events.includes("COUNTER_CAS"), false);
  assert.equal(state.events.includes("SESSION_CREATE"), false);
});

test("hook-absent authentication path performs no selector binding", async () => {
  const state = fixture();
  const result = await state.run();
  assert.equal(result.status, "authenticated");
  assert.equal(state.events.includes("SELECTOR_BIND"), false);
});

test("source uses Better Auth orchestration and exposes no raw transaction or HTTP layer", () => {
  assert.match(source, /runWithTransaction/);
  assert.match(source, /getCurrentAdapter/);
  assert.match(source, /passkeyCeremonyServices\.verifyAuthentication/);
  assert.match(source, /internalAdapter\.createSession/);
  assert.match(source, /insertPasskeySessionMarker/);
  assert.match(source, /setSessionCookie/);
  assert.doesNotMatch(source, /from\s+["']pg["']|PoolClient|\.query\s*\(/);
  assert.doesNotMatch(source, /generateAuthenticationOptions|verifyAuthenticationResponse/);
  assert.doesNotMatch(source, /createAuthEndpoint|\/api\/v1|passkey-rate-limit|mfa-security-audit/);
  assert.doesNotMatch(source, /assurance_level|trusted_device|strong_auth/);
});

test("only narrow I5 rejection classes are eligible for committed rejection", () => {
  assert.match(source, /error\.code === "AUTHENTICATION_REJECTED"/);
  assert.match(source, /error\.code === "CHALLENGE_REJECTED"/);
  assert.doesNotMatch(source, /error\.code === "SERVICE_UNAVAILABLE"/);
  assert.doesNotMatch(source, /catch\s*\([^)]*\)\s*\{\s*return Object\.freeze\(\{ kind: "rejected"/s);
});

test("I6 source returns no session token or authenticated cookie material", async () => {
  const state = fixture();
  const outcome = await state.run();
  assert.deepEqual(Object.keys(outcome), ["status"]);
  assert.equal("token" in outcome, false);
  assert.ok(PasskeyAuthenticationFailure);
});
