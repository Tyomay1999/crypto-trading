import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const pluginSource = readFileSync(
  "src/auth/passkey-public-plugin.ts",
  "utf8",
);
const coreSource = readFileSync(
  "src/auth/core.ts",
  "utf8",
);
const c1Source = readFileSync(
  "src/auth/passkey-plugin.ts",
  "utf8",
);
const appSource = readFileSync(
  "src/app.ts",
  "utf8",
);
const serverSource = readFileSync(
  "src/server.ts",
  "utf8",
);

function loadCommonJs(source, fileName, imports) {
  const module = { exports: {} };
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName,
  }).outputText;
  vm.runInNewContext(output, {
    exports: module.exports,
    module,
    require(specifier) {
      if (specifier in imports) return imports[specifier];
      throw new Error(`Unexpected authentication test import: ${specifier}`);
    },
    Buffer,
    Date,
    Error,
    Headers,
    JSON,
    Map,
    Number,
    Object,
    Set,
    URL,
  });
  return module.exports;
}

class FakeCeremonyError extends Error {
  constructor(code) {
    super("Synthetic passkey rejection.");
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

const c1Module = loadCommonJs(
  c1Source,
  "passkey-plugin.ts",
  {
    "@better-auth/core/context": {
      async getCurrentAdapter(adapter) {
        return adapter;
      },
      async runWithTransaction(_adapter, fn) {
        return fn();
      },
    },
    "better-auth/cookies": {
      async setSessionCookie() {},
    },
    "./passkey-ceremony.js": {
      PasskeyCeremonyError: FakeCeremonyError,
      passkeyCeremonyServices: {
        async verifyAuthentication() {
          throw new Error("unused production verifier");
        },
      },
    },
    "./passkey-challenge.js": {
      clearPasskeyLookupCookie() {},
    },
    "./passkey-counter.js": {
      passkeyCounterFromDatabase: counterFromDatabase,
      passkeyCounterToDatabase: counterToDatabase,
    },
    "../storage/passkey-session-marker.js": {
      async insertPasskeySessionMarker() {},
    },
  },
);

function createAuthEndpoint(path, options, handler) {
  handler.path = path;
  handler.options = options;
  return handler;
}

let sessionLookupCount = 0;

const pluginModule = loadCommonJs(
  pluginSource,
  "passkey-public-plugin.ts",
  {
    "@better-auth/core/context": {
      async getCurrentAdapter(adapter) {
        return adapter;
      },
      async runWithTransaction(_adapter, fn) {
        return fn();
      },
    },
    "better-auth/api": {
      createAuthEndpoint,
      async getSessionFromCtx() {
        sessionLookupCount += 1;
        return null;
      },
    },
    "./passkey-ceremony.js": {
      PasskeyCeremonyError: FakeCeremonyError,
      passkeyCeremonyServices: {
        async registrationOptions() {
          return { challenge: "synthetic" };
        },
        async verifyRegistration() {
          throw new Error("unused registration verifier");
        },
        async authenticationOptions() {
          return { challenge: "synthetic" };
        },
      },
    },
    "./passkey-plugin.js": c1Module,
    "./passkey-challenge.js": {
      clearPasskeyLookupCookie() {},
    },
    "./passkey-management-proof.js": {
      createTrustedPasskeyManagementContext() {
        throw new Error("unused management context");
      },
      async verifyPasskeyManagementFreshProof() {
        throw new Error("unused management proof");
      },
    },
    "./mfa-security-audit.js": {
      tryLogPasskeySecurityAuditEvent() {},
    },
    "../storage/passkey-rate-limit.js": {
      createPasskeyDurableRateLimiter() {
        return async () => true;
      },
    },
  },
);

const plain = (value) => JSON.parse(JSON.stringify(value));

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

function harness(overrides = {}) {
  const events = [];
  const audits = [];
  const baseAdapter = { name: "base" };
  const transactionAdapter = {
    name: "transaction",
    async findOne(query) {
      if (query.model === "passkey") {
        events.push("CREDENTIAL_OWNER");
        return {
          id: "passkey-b",
          userId: "user-b",
          counter: overrides.storedCounter ?? 10,
        };
      }
      if (query.model === "user") {
        events.push("USER_LOAD");
        return {
          id: "user-b",
          email: "synthetic-user@example.test",
          emailVerified: true,
          name: "Synthetic User",
          image: null,
          createdAt: new Date(0),
          updatedAt: new Date(0),
        };
      }
      throw new Error("unexpected model");
    },
    async incrementOne(query) {
      events.push(`COUNTER_CAS:${query.where[1].value}->${query.set.counter}`);
      if (overrides.casFailure) return null;
      pending.counter = query.set.counter;
      return {
        id: "passkey-b",
        userId: "user-b",
        counter: query.set.counter,
      };
    },
  };
  const durable = {
    challenge: true,
    counter: overrides.storedCounter ?? 10,
    session: false,
    provenance: false,
  };
  let pending = null;
  let inTransaction = false;

  const context = {
    existingSession: { userId: "user-a" },
    context: {
      internalAdapter: {
        async createSession(userId) {
          assert.equal(inTransaction, true);
          assert.equal(userId, "user-b");
          events.push("SESSION_CREATE:user-b");
          if (overrides.sessionFailure) {
            throw new Error("synthetic session storage failure");
          }
          pending.session = true;
          return {
            id: "session-b",
            token: "synthetic-token-not-public",
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

  const orchestrator = c1Module.createPasskeyAuthenticationOrchestrator({
    async runTransaction(adapter, callback) {
      assert.equal(adapter, baseAdapter);
      events.push("TX_BEGIN");
      pending = { ...durable };
      inTransaction = true;
      try {
        const result = await callback();
        if (overrides.commitFailure) {
          events.push("TX_COMMIT_FAILURE");
          throw new Error("synthetic commit failure");
        }
        Object.assign(durable, pending);
        events.push("TX_COMMIT");
        return result;
      } catch (error) {
        events.push("TX_ROLLBACK");
        throw error;
      } finally {
        inTransaction = false;
        pending = null;
      }
    },
    async currentAdapter(adapter) {
      assert.equal(adapter, baseAdapter);
      assert.equal(inTransaction, true);
      return transactionAdapter;
    },
    async verifyAuthentication() {
      assert.equal(inTransaction, true);
      events.push("CHALLENGE_CLAIM");
      if (overrides.challengeInfrastructure) {
        throw new FakeCeremonyError("SERVICE_UNAVAILABLE");
      }
      pending.challenge = false;
      if (overrides.expectedRejection) {
        events.push("WEBAUTHN_REJECTED");
        throw new FakeCeremonyError("AUTHENTICATION_REJECTED");
      }
      events.push("WEBAUTHN_VERIFY");
      return Object.freeze({
        passkeyId: "passkey-b",
        userId: "user-b",
        newCounter: overrides.newCounter ?? 11,
        userVerified: true,
        credentialDeviceType: "multiDevice",
        credentialBackedUp: true,
        aaguid: null,
        transports: null,
      });
    },
    async insertProvenance(adapter, marker) {
      assert.equal(adapter, transactionAdapter);
      assert.equal(inTransaction, true);
      assert.equal(marker.sessionId, "session-b");
      assert.equal(marker.passkeyId, "passkey-b");
      events.push("PROVENANCE_WRITE:passkey");
      if (overrides.provenanceFailure) {
        throw new Error("synthetic provenance failure");
      }
      pending.provenance = true;
    },
    async setAuthCookie(_context, pair) {
      assert.equal(inTransaction, false);
      assert.equal(pair.user.id, "user-b");
      assert.equal(pair.session.userId, "user-b");
      events.push("AUTH_COOKIE_ELIGIBLE");
    },
    clearLookupCookie() {
      assert.equal(inTransaction, false);
      events.push("LOOKUP_CLEAR_ELIGIBLE");
    },
    now: () => new Date("2026-09-12T00:00:00.000Z"),
  });

  const service = pluginModule.createPasskeyAuthenticationService({
    async currentAdapter(adapter) {
      return adapter;
    },
    async takeDurableLimit(input) {
      events.push(`LIMIT:${input.operation}:${input.identity.kind}`);
      if (overrides.rateInfrastructure) {
        throw new Error("synthetic rate storage failure");
      }
      return overrides.rateLimited !== true;
    },
    async authenticationOptions(input) {
      assert.equal("authoritativeUserId" in input, false);
      events.push("CHALLENGE_ISSUE");
      events.push("LOOKUP_SET_ELIGIBLE");
      return Object.freeze({
        challenge: "synthetic-discoverable-challenge",
        rpId: config.rpId,
      });
    },
    authenticate: orchestrator,
    emitAudit(requestId, action, outcome, metadata) {
      audits.push({ requestId, action, outcome, metadata });
    },
  });

  const optionsInput = {
    adapter: baseAdapter,
    context,
    config,
    requestId: "server-request-id",
    networkSource: "synthetic-network-principal",
  };
  const verifyInput = {
    ...optionsInput,
    response: { id: "synthetic-browser-response" },
  };
  return {
    audits,
    context,
    durable,
    events,
    optionsInput,
    service,
    verifyInput,
  };
}

test("internal authentication endpoints and API names are exact", () => {
  assert.equal(
    pluginModule.DELTA_INTERNAL_PASSKEY_AUTHENTICATION_ENDPOINT_COUNT,
    2,
  );
  assert.deepEqual(
    plain(pluginModule.DELTA_INTERNAL_PASSKEY_AUTHENTICATION_PATHS),
    [
      "/delta-passkey/authentication/options",
      "/delta-passkey/authentication/verify",
    ],
  );
  assert.deepEqual(
    plain(pluginModule.DELTA_INTERNAL_PASSKEY_AUTHENTICATION_API_METHODS),
    [
      "deltaPasskeyAuthenticationOptions",
      "deltaPasskeyAuthenticationVerify",
    ],
  );
  const plugin = pluginModule.passkeyPublicPlugin(
    { query: async () => ({ rowCount: 0, rows: [] }) },
    { recoveryPepper: "synthetic", webauthn: config },
  );
  assert.equal(
    plugin.endpoints.deltaPasskeyAuthenticationOptions.path,
    "/delta-passkey/authentication/options",
  );
  assert.equal(
    plugin.endpoints.deltaPasskeyAuthenticationVerify.path,
    "/delta-passkey/authentication/verify",
  );
});

test("auth core contains both internal slices and all raw Better Auth passkey routes", () => {
  for (const path of [
    "/delta-passkey/enrollment/options",
    "/delta-passkey/enrollment/verify",
    "/delta-passkey/authentication/options",
    "/delta-passkey/authentication/verify",
    "/passkey/generate-register-options",
    "/passkey/generate-authenticate-options",
    "/passkey/verify-registration",
    "/passkey/verify-authentication",
    "/passkey/list-user-passkeys",
    "/passkey/delete-passkey",
    "/passkey/update-passkey",
  ]) {
    assert.equal(coreSource.includes(JSON.stringify(path)), true, path);
  }
});

test("authentication endpoints are programmatic and do not consult existing session identity", async () => {
  const plugin = pluginModule.passkeyPublicPlugin(
    { query: async () => ({ rowCount: 0, rows: [] }) },
    { recoveryPepper: "synthetic", webauthn: config },
  );
  sessionLookupCount = 0;
  const result = await plugin.endpoints.deltaPasskeyAuthenticationOptions({
    body: { userId: "user-a" },
    headers: new Headers({ "x-real-ip": "synthetic-network" }),
    context: { adapter: {} },
    setStatus() {},
    json(body, init) {
      return { body, status: init.status };
    },
  });
  assert.equal(result.status, 400);
  assert.equal(sessionLookupCount, 0);
});

test("authentication bridge reuses the C1 orchestrator and not SimpleWebAuthn directly", () => {
  assert.match(pluginSource, /authenticatePasskey/);
  assert.match(pluginSource, /import\(\s*"\.\/passkey-plugin\.js"\s*\)/);
  assert.doesNotMatch(pluginSource, /@simplewebauthn\/server/);
  assert.doesNotMatch(pluginSource, /verifyAuthenticationResponse/);
});

test("discoverable options rate limit precedes challenge and uses network only", async () => {
  const state = harness();
  const result = await state.service.authenticationOptions(state.optionsInput);
  assert.equal(result.kind, "success");
  assert.deepEqual(state.events, [
    "LIMIT:authenticationOptions:network",
    "CHALLENGE_ISSUE",
    "LOOKUP_SET_ELIGIBLE",
  ]);
  assert.equal(JSON.stringify(result).includes("user-a"), false);
  assert.equal(JSON.stringify(result).includes("user-b"), false);
});

test("options rate rejection issues no challenge or cookie", async () => {
  const state = harness({ rateLimited: true });
  const result = await state.service.authenticationOptions(state.optionsInput);
  assert.equal(result.kind, "error");
  assert.equal(result.code, "PASSKEY_RATE_LIMITED");
  assert.deepEqual(state.events, ["LIMIT:authenticationOptions:network"]);
});

test("options rate infrastructure failure fails closed before challenge", async () => {
  const state = harness({ rateInfrastructure: true });
  const result = await state.service.authenticationOptions(state.optionsInput);
  assert.equal(result.kind, "error");
  assert.equal(result.code, "PASSKEY_UNAVAILABLE");
  assert.deepEqual(state.events, ["LIMIT:authenticationOptions:network"]);
});

test("stored passkey owner overrides an unrelated existing browser session", async () => {
  const state = harness();
  assert.equal(state.context.existingSession.userId, "user-a");
  const result = await state.service.authenticationVerify(state.verifyInput);
  assert.deepEqual(plain(result), { kind: "success", status: true });
  assert.equal(state.events.includes("SESSION_CREATE:user-b"), true);
  assert.equal(state.events.includes("SESSION_CREATE:user-a"), false);
});

test("successful positive-counter authentication preserves the authoritative order", async () => {
  const state = harness();
  await state.service.authenticationVerify(state.verifyInput);
  assert.deepEqual(state.events, [
    "LIMIT:authenticationVerify:network",
    "TX_BEGIN",
    "CHALLENGE_CLAIM",
    "WEBAUTHN_VERIFY",
    "CREDENTIAL_OWNER",
    "COUNTER_CAS:10->11",
    "USER_LOAD",
    "SESSION_CREATE:user-b",
    "PROVENANCE_WRITE:passkey",
    "TX_COMMIT",
    "AUTH_COOKIE_ELIGIBLE",
    "LOOKUP_CLEAR_ELIGIBLE",
  ]);
  assert.equal(state.durable.counter, 11);
  assert.equal(state.durable.session, true);
  assert.equal(state.durable.provenance, true);
});

test("zero-to-zero authentication succeeds without a counter write", async () => {
  const state = harness({ storedCounter: 0, newCounter: 0 });
  const result = await state.service.authenticationVerify(state.verifyInput);
  assert.equal(result.kind, "success");
  assert.equal(state.events.some((event) => event.startsWith("COUNTER_CAS")), false);
  assert.equal(c1Module.validatePasskeyCounterTransition(0, 0).requiresCas, false);
});

test("zero-to-positive authentication uses conditional counter update", async () => {
  const state = harness({ storedCounter: 0, newCounter: 1 });
  await state.service.authenticationVerify(state.verifyInput);
  assert.equal(state.events.includes("COUNTER_CAS:0->1"), true);
  assert.equal(state.durable.counter, 1);
});

for (const [label, stored, next] of [
  ["equal positive", 10, 10],
  ["positive to zero", 10, 0],
  ["decreasing positive", 10, 9],
]) {
  test(`${label} counter state is rejected without exposing values`, async () => {
    assert.throws(
      () => c1Module.validatePasskeyCounterTransition(stored, next),
      (error) => error.code === "AUTHENTICATION_STATE_FAILURE",
    );
    const state = harness({ expectedRejection: true });
    const result = await state.service.authenticationVerify(state.verifyInput);
    assert.equal(result.kind, "error");
    assert.equal(result.code, "PASSKEY_REQUEST_REJECTED");
    assert.equal(JSON.stringify(result).includes(String(stored)), false);
  });
}

for (const scenario of ["unknown credential", "invalid signature"]) {
  test(`${scenario} is one enumeration-safe committed rejection`, async () => {
    const state = harness({ expectedRejection: true });
    const result = await state.service.authenticationVerify(state.verifyInput);
    assert.deepEqual(plain(result), {
      kind: "error",
      code: "PASSKEY_REQUEST_REJECTED",
    });
    assert.equal(state.durable.challenge, false);
    assert.equal(state.durable.session, false);
    assert.equal(state.durable.provenance, false);
    assert.equal(state.events.includes("AUTH_COOKIE_ELIGIBLE"), false);
    assert.equal(state.events.includes("LOOKUP_CLEAR_ELIGIBLE"), true);
  });
}

test("expected proof rejection commits challenge consumption only", async () => {
  const state = harness({ expectedRejection: true });
  await state.service.authenticationVerify(state.verifyInput);
  assert.deepEqual(state.events, [
    "LIMIT:authenticationVerify:network",
    "TX_BEGIN",
    "CHALLENGE_CLAIM",
    "WEBAUTHN_REJECTED",
    "TX_COMMIT",
    "LOOKUP_CLEAR_ELIGIBLE",
  ]);
  assert.equal(state.durable.challenge, false);
  assert.equal(state.durable.counter, 10);
});

test("challenge storage infrastructure failure rolls back and preserves lookup", async () => {
  const state = harness({ challengeInfrastructure: true });
  const result = await state.service.authenticationVerify(state.verifyInput);
  assert.equal(result.code, "PASSKEY_UNAVAILABLE");
  assert.equal(state.events.includes("TX_ROLLBACK"), true);
  assert.equal(state.durable.challenge, true);
  assert.equal(state.events.includes("LOOKUP_CLEAR_ELIGIBLE"), false);
});

test("counter CAS failure rolls back before session and preserves challenge", async () => {
  const state = harness({ casFailure: true });
  const result = await state.service.authenticationVerify(state.verifyInput);
  assert.equal(result.code, "PASSKEY_UNAVAILABLE");
  assert.equal(state.events.includes("TX_ROLLBACK"), true);
  assert.equal(state.events.includes("SESSION_CREATE:user-b"), false);
  assert.equal(state.durable.challenge, true);
});

test("session creation failure rolls back counter and challenge", async () => {
  const state = harness({ sessionFailure: true });
  const result = await state.service.authenticationVerify(state.verifyInput);
  assert.equal(result.code, "PASSKEY_UNAVAILABLE");
  assert.equal(state.events.includes("TX_ROLLBACK"), true);
  assert.equal(state.durable.counter, 10);
  assert.equal(state.durable.challenge, true);
  assert.equal(state.events.includes("AUTH_COOKIE_ELIGIBLE"), false);
});

test("provenance failure rolls back session counter and challenge", async () => {
  const state = harness({ provenanceFailure: true });
  const result = await state.service.authenticationVerify(state.verifyInput);
  assert.equal(result.code, "PASSKEY_UNAVAILABLE");
  assert.equal(state.events.includes("SESSION_CREATE:user-b"), true);
  assert.equal(state.events.includes("TX_ROLLBACK"), true);
  assert.deepEqual(state.durable, {
    challenge: true,
    counter: 10,
    session: false,
    provenance: false,
  });
});

test("commit failure exposes neither auth cookie nor lookup clear", async () => {
  const state = harness({ commitFailure: true });
  const result = await state.service.authenticationVerify(state.verifyInput);
  assert.equal(result.code, "PASSKEY_UNAVAILABLE");
  assert.equal(state.events.includes("TX_COMMIT_FAILURE"), true);
  assert.equal(state.events.includes("AUTH_COOKIE_ELIGIBLE"), false);
  assert.equal(state.events.includes("LOOKUP_CLEAR_ELIGIBLE"), false);
  assert.equal(state.durable.challenge, true);
});

test("auth cookie and lookup clear become eligible only after commit", async () => {
  const state = harness();
  await state.service.authenticationVerify(state.verifyInput);
  assert.ok(state.events.indexOf("TX_COMMIT") < state.events.indexOf("AUTH_COOKIE_ELIGIBLE"));
  assert.ok(state.events.indexOf("AUTH_COOKIE_ELIGIBLE") < state.events.indexOf("LOOKUP_CLEAR_ELIGIBLE"));
});

test("authentication success returns only the public status contract", async () => {
  const state = harness();
  const result = await state.service.authenticationVerify(state.verifyInput);
  assert.deepEqual(plain(result), { kind: "success", status: true });
  for (const forbidden of [
    "userId",
    "email",
    "session",
    "token",
    "credential",
    "counter",
  ]) {
    assert.equal(forbidden in result, false);
  }
});

test("authentication audit contains only coarse accepted metadata", async () => {
  const state = harness();
  await state.service.authenticationVerify(state.verifyInput);
  assert.equal(
    state.audits.some((audit) => audit.action === "passkey_authentication"),
    true,
  );
  const serialized = JSON.stringify(state.audits);
  for (const forbidden of [
    "synthetic-browser-response",
    "synthetic-token-not-public",
    "synthetic-user@example.test",
    "passkey-b",
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test("I6 exposes authentication only through the accepted public router composition", () => {
  for (const forbidden of [
    "assuranceLevel",
    "trustedDevice",
    "stepUpSatisfied",
    "managementList",
    "managementRename",
    "managementDelete",
  ]) {
    assert.equal(pluginSource.includes(forbidden), false, forbidden);
  }
  assert.equal(
    (appSource.match(/app\.use\(\s*PASSKEY_PUBLIC_PREFIX,/g) ?? []).length,
    2,
  );
  assert.equal(
    (appSource.match(/createPasskeyAuthenticationRouteOperations\s*\(/g) ?? []).length,
    1,
  );
  assert.ok(
    appSource.indexOf("createPasskeyRouter({") <
      appSource.indexOf("app.use(notFoundMiddleware)"),
  );
  assert.doesNotMatch(
    appSource,
    /createPasskeyAuthenticationService|authenticatePasskey|verifyAuthenticationResponse|runWithTransaction/,
  );
  for (const path of [
    "/delta-passkey/authentication/options",
    "/delta-passkey/authentication/verify",
  ]) {
    assert.ok(coreSource.includes(`"${path}"`), path);
  }
  assert.equal(serverSource.includes("passkey.routes"), false);
});
