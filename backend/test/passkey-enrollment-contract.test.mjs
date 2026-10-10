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
const managementProofSource = readFileSync(
  "src/auth/passkey-management-proof.ts",
  "utf8",
);

function loadCommonJs(
  source,
  fileName,
  imports,
  globals = {},
) {
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
      if (specifier in imports) {
        return imports[specifier];
      }
      throw new Error(
        `Unexpected enrollment test import: ${specifier}`,
      );
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
    ...globals,
  });
  return module.exports;
}

const managementProof = loadCommonJs(
  managementProofSource,
  "passkey-management-proof.ts",
  {
    "./password-policy.js": {
      AUTH_PASSWORD_MIN_LENGTH: 12,
      AUTH_PASSWORD_MAX_LENGTH: 128,
    },
    "./totp-replay.js": {
      createTotpReplayDigest() {
        return "a".repeat(64);
      },
    },
    "./totp-replacement.js": {
      isValidTotpCode(value) {
        return /^[0-9]{6}$/.test(value);
      },
      async verifyEncryptedTotpCode() {
        throw new Error("unused default verifier");
      },
    },
  },
);

class FakeCeremonyError extends Error {
  constructor(code) {
    super("Synthetic ceremony rejection.");
    this.code = code;
  }
}

function createAuthEndpoint(
  path,
  options,
  handler,
) {
  handler.path = path;
  handler.options = options;
  return handler;
}

let endpointSession = null;

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
        return endpointSession;
      },
    },
    "./passkey-ceremony.js": {
      PasskeyCeremonyError:
        FakeCeremonyError,
      passkeyCeremonyServices: {
        async registrationOptions() {
          return { challenge: "synthetic" };
        },
        async verifyRegistration() {
          throw new Error("unused production verifier");
        },
      },
    },
    "./passkey-challenge.js": {
      clearPasskeyLookupCookie() {},
    },
    "./passkey-management-proof.js":
      managementProof,
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

const plain = (value) =>
  JSON.parse(JSON.stringify(value));

const baseConfig = Object.freeze({
  rpId: "example.test",
  rpName: "Delta",
  origin: "https://example.test",
  userVerification: "required",
  attestation: "none",
  residentKey: "preferred",
  requireResidentKey: false,
  requireUserPresence: true,
});

const baseSession = Object.freeze({
  sessionId: "synthetic-session",
  user: Object.freeze({
    id: "synthetic-user-a",
    email: "person@example.test",
    name: "Synthetic Person",
  }),
});

function proofDependencies(
  events,
  overrides = {},
) {
  const active =
    overrides.active !== false;
  const now = new Date(
    "2026-09-11T12:00:00.000Z",
  );
  return {
    async loadSecurityState() {
      events.push("SECURITY_STATE");
      return active
        ? {
            sessionValid: true,
            passwordHash:
              "synthetic-password-hash",
            totp: {
              state: "active",
              encryptedSecret:
                "synthetic-encrypted-factor",
              lockedUntil: null,
            },
          }
        : {
            sessionValid: true,
            passwordHash:
              "synthetic-password-hash",
            totp: { state: "absent" },
          };
    },
    async verifyPassword() {
      events.push("PASSWORD_PROOF");
      return overrides.passwordValid !==
        false;
    },
    async claimTotpReplay() {
      events.push("TOTP_REPLAY_CLAIM");
      return overrides.replayAllowed !==
        false;
    },
    encryptionKey:
      "synthetic-encryption-key-material",
    replayPepper:
      "synthetic-replay-key-material-0123456789",
    now: () => new Date(now),
    async verifyTotp() {
      events.push("TOTP_PROOF");
      return overrides.totpValid !== false;
    },
  };
}

function optionsHarness(overrides = {}) {
  const events = [];
  const audits = [];
  const cookieWrites = [];
  const dependencies = {
    async runTransaction() {
      throw new Error("options must not transact");
    },
    async currentAdapter(adapter) {
      return adapter;
    },
    async takeDurableLimit(input) {
      events.push(
        `LIMIT:${input.operation}:${input.identity.kind}`,
      );
      if (
        overrides.limitFailure ===
        input.operation
      ) {
        return false;
      }
      if (
        overrides.limitInfrastructure ===
        input.operation
      ) {
        throw new Error(
          "synthetic limiter detail",
        );
      }
      return true;
    },
    async registrationOptions(input) {
      events.push("CHALLENGE_ISSUE");
      assert.equal(
        input.user.id,
        baseSession.user.id,
      );
      cookieWrites.push("lookup-set");
      return Object.freeze({
        challenge: "synthetic-challenge",
        rp: { id: baseConfig.rpId },
      });
    },
    async verifyRegistration() {
      throw new Error("options must not verify");
    },
    createTrustedContext:
      managementProof
        .createTrustedPasskeyManagementContext,
    verifyFreshProof:
      managementProof
        .verifyPasskeyManagementFreshProof,
    clearLookupCookie() {
      throw new Error("options must not clear");
    },
    emitAudit(
      _requestId,
      action,
      outcome,
      metadata,
    ) {
      audits.push({ action, outcome, metadata });
    },
  };
  const service =
    pluginModule.createPasskeyEnrollmentService(
      dependencies,
    );
  const proofEvents = events;
  const input = {
    adapter: {},
    context: {},
    config: baseConfig,
    trustedOrigins: [
      "https://example.test",
    ],
    session: baseSession,
    requestOrigin:
      "https://example.test",
    requestId: "server-request-id",
    networkSource:
      "synthetic-network-principal",
    proof: {
      password:
        "synthetic-current-password",
      totpCode: "123456",
    },
    proofDependencies:
      proofDependencies(
        proofEvents,
        overrides,
      ),
  };
  return {
    audits,
    cookieWrites,
    events,
    input,
    service,
  };
}

function verifyHarness(mode = "success", selectorHook) {
  const events = [];
  const audits = [];
  let durableChallenge = true;
  let durableCredential = false;
  let pending = null;
  const baseAdapter = {};
  const transactionAdapter = {};
  const dependencies = {
    async runTransaction(adapter, fn) {
      assert.equal(adapter, baseAdapter);
      events.push("TX_BEGIN");
      pending = {
        challenge: durableChallenge,
        credential: durableCredential,
      };
      try {
        const value = await fn();
        durableChallenge =
          pending.challenge;
        durableCredential =
          pending.credential;
        events.push("TX_COMMIT");
        return value;
      } catch (error) {
        events.push("TX_ROLLBACK");
        throw error;
      } finally {
        pending = null;
      }
    },
    async currentAdapter() {
      return pending
        ? transactionAdapter
        : baseAdapter;
    },
    async takeDurableLimit(input) {
      events.push(
        `LIMIT:${input.operation}:${input.identity.kind}`,
      );
      if (mode === "rate-limit") {
        return false;
      }
      if (mode === "rate-infrastructure") {
        throw new Error(
          "synthetic rate store detail",
        );
      }
      return true;
    },
    async registrationOptions() {
      throw new Error("verify must not issue challenge");
    },
    async verifyRegistration(input) {
      assert.equal(
        input.adapter,
        transactionAdapter,
      );
      events.push("CHALLENGE_CLAIM");
      if (!pending?.challenge) {
        throw new FakeCeremonyError(
          "CHALLENGE_REJECTED",
        );
      }
      if (
        input.userId !==
        baseSession.user.id
      ) {
        pending.challenge = false;
        throw new FakeCeremonyError(
          "CHALLENGE_REJECTED",
        );
      }
      if (mode === "challenge-infrastructure") {
        throw new FakeCeremonyError(
          "SERVICE_UNAVAILABLE",
        );
      }
      pending.challenge = false;
      events.push("VERIFY_REGISTRATION");
      if (mode === "proof-rejection") {
        throw new FakeCeremonyError(
          "REGISTRATION_REJECTED",
        );
      }
      events.push("CREDENTIAL_INSERT");
      if (mode === "duplicate") {
        throw new FakeCeremonyError(
          "CREDENTIAL_CONFLICT",
        );
      }
      if (mode === "insert-infrastructure") {
        throw new FakeCeremonyError(
          "SERVICE_UNAVAILABLE",
        );
      }
      pending.credential = true;
      return Object.freeze({
        passkeyId: "synthetic-passkey-id",
        userId: input.userId,
        credentialID:
          "synthetic-credential-id",
        userVerified: true,
        credentialDeviceType:
          "multiDevice",
        credentialBackedUp: true,
        aaguid: null,
        transports: null,
      });
    },
    createTrustedContext() {
      throw new Error("verify must not repeat proof");
    },
    async verifyFreshProof() {
      throw new Error("verify must not repeat proof");
    },
    clearLookupCookie() {
      events.push("LOOKUP_COOKIE_CLEAR");
    },
    emitAudit(
      _requestId,
      action,
      outcome,
      metadata,
    ) {
      audits.push({ action, outcome, metadata });
    },
    ...(selectorHook === undefined
      ? {}
      : {
          async bindTestTransactionSelector(input) {
            assert.equal(input.adapter, transactionAdapter);
            assert.equal(input.context, verifyInputContext);
            events.push("SELECTOR_BIND");
            await selectorHook(input);
          },
        }),
  };
  const service =
    pluginModule.createPasskeyEnrollmentService(
      dependencies,
    );
  const verifyInputContext = {};
  const input = {
    adapter: baseAdapter,
    context: verifyInputContext,
    config: baseConfig,
    session: baseSession,
    requestId: "server-request-id",
    networkSource:
      "synthetic-network-principal",
    response: { id: "opaque" },
    name: "Synthetic key",
  };
  return {
    audits,
    events,
    input,
    service,
    get challengePresent() {
      return durableChallenge;
    },
    get credentialPresent() {
      return durableCredential;
    },
  };
}

test("internal enrollment plugin declares exactly two contained endpoints", () => {
  assert.equal(
    pluginModule
      .DELTA_INTERNAL_PASSKEY_ENROLLMENT_ENDPOINT_COUNT,
    2,
  );
  assert.deepEqual(
    plain(
      pluginModule
        .DELTA_INTERNAL_PASSKEY_ENROLLMENT_PATHS,
    ),
    [
      "/delta-passkey/enrollment/options",
      "/delta-passkey/enrollment/verify",
    ],
  );
  assert.deepEqual(
    plain(
      pluginModule
        .DELTA_INTERNAL_PASSKEY_ENROLLMENT_API_METHODS,
    ),
    [
      "deltaPasskeyEnrollmentOptions",
      "deltaPasskeyEnrollmentVerify",
    ],
  );
  for (const path of
    pluginModule
      .DELTA_INTERNAL_PASSKEY_ENROLLMENT_PATHS) {
    assert.equal(
      coreSource.split(`"${path}"`).length - 1,
      1,
    );
  }
});

test("plugin registration preserves official, overlay, then internal bridge order", () => {
  const official =
    coreSource.indexOf("passkey({");
  const overlay =
    coreSource.indexOf(
      "deltaPasskeySchemaOverlayPlugin,",
      official,
    );
  const bridge =
    coreSource.indexOf(
      "passkeyPublicPlugin(database, env)",
      overlay,
    );
  assert.ok(official >= 0);
  assert.ok(overlay > official);
  assert.ok(bridge > overlay);
  assert.match(
    coreSource,
    /import \{ passkeyPublicPlugin \} from "\.\/passkey-public-plugin\.js"/,
  );
});

test("programmatic endpoint names and raw paths are paired without public route aliases", () => {
  const plugin =
    pluginModule.passkeyPublicPlugin(
      { async query() { return { rowCount: 0, rows: [] }; } },
      {
        secret: "s".repeat(32),
        replayPepper: "t".repeat(32),
        recoveryPepper: "r".repeat(32),
        baseUrl: "https://example.test",
        trustedOrigins: ["https://example.test"],
        useSecureCookies: true,
        webauthn: baseConfig,
      },
    );
  const enrollmentEndpointNames =
    Object.keys(plugin.endpoints).filter(
      (name) =>
        name.startsWith(
          "deltaPasskeyEnrollment",
        ),
    );
  assert.deepEqual(
    enrollmentEndpointNames,
    [
      "deltaPasskeyEnrollmentOptions",
      "deltaPasskeyEnrollmentVerify",
    ],
  );
  assert.equal(
    plugin.endpoints
      .deltaPasskeyEnrollmentOptions.path,
    "/delta-passkey/enrollment/options",
  );
  assert.equal(
    plugin.endpoints
      .deltaPasskeyEnrollmentVerify.path,
    "/delta-passkey/enrollment/verify",
  );
  assert.doesNotMatch(
    pluginSource,
    /\/api\/v1\/auth\/passkeys/,
  );
});

test("internal enrollment endpoint requires a current session and rejects body identity hints", async () => {
  const plugin =
    pluginModule.passkeyPublicPlugin(
      { async query() { throw new Error("database must not be reached"); } },
      {
        secret: "s".repeat(32),
        replayPepper: "t".repeat(32),
        recoveryPepper: "r".repeat(32),
        baseUrl: "https://example.test",
        trustedOrigins: ["https://example.test"],
        useSecureCookies: true,
        webauthn: baseConfig,
      },
    );
  const context = {
    body: {
      password: "synthetic-current-password",
    },
    headers: new Headers({
      origin: "https://example.test",
      "x-real-ip": "synthetic-network",
      "x-request-id": "server-request-id",
    }),
    context: {
      adapter: {},
      password: { verify: async () => true },
    },
    setStatus() {},
    json(body, options) {
      return { body, status: options.status };
    },
  };
  endpointSession = null;
  const absent =
    await plugin.endpoints
      .deltaPasskeyEnrollmentOptions(
        context,
      );
  assert.equal(absent.status, 401);
  assert.equal(
    absent.body.error.code,
    "PASSKEY_REQUEST_REJECTED",
  );
  const absentAtVerify =
    await plugin.endpoints
      .deltaPasskeyEnrollmentVerify({
        ...context,
        body: {
          response: { id: "opaque" },
        },
      });
  assert.equal(absentAtVerify.status, 401);
  assert.equal(
    absentAtVerify.body.error.code,
    "PASSKEY_REQUEST_REJECTED",
  );

  endpointSession = {
    session: {
      id: "synthetic-session",
    },
    user: {
      id: "synthetic-user-a",
      email: "person@example.test",
      name: "Synthetic Person",
    },
  };
  const hinted =
    await plugin.endpoints
      .deltaPasskeyEnrollmentOptions({
        ...context,
        body: {
          ...context.body,
          userId: "synthetic-user-b",
        },
      });
  assert.equal(hinted.status, 400);
  assert.equal(
    hinted.body.error.code,
    "PASSKEY_REQUEST_REJECTED",
  );
  endpointSession = null;
});

test("registration options enforces both limiter domains before fresh proof and challenge", async () => {
  const harness = optionsHarness();
  const result =
    await harness.service
      .registrationOptions(
        harness.input,
      );
  assert.equal(result.kind, "success");
  assert.deepEqual(harness.events, [
    "LIMIT:registrationOptions:network",
    "LIMIT:registrationOptions:user",
    "LIMIT:managementFreshProof:network",
    "LIMIT:managementFreshProof:user",
    "SECURITY_STATE",
    "PASSWORD_PROOF",
    "TOTP_PROOF",
    "TOTP_REPLAY_CLAIM",
    "CHALLENGE_ISSUE",
  ]);
  assert.deepEqual(
    harness.cookieWrites,
    ["lookup-set"],
  );
});

test("wrong password rejects before TOTP, challenge, credential, or cookie", async () => {
  const harness = optionsHarness({
    passwordValid: false,
  });
  const result =
    await harness.service
      .registrationOptions(
        harness.input,
      );
  assert.equal(
    result.code,
    "PASSKEY_FRESH_PROOF_REJECTED",
  );
  assert.equal(
    harness.events.includes(
      "CHALLENGE_ISSUE",
    ),
    false,
  );
  assert.equal(
    harness.events.includes(
      "TOTP_REPLAY_CLAIM",
    ),
    false,
  );
  assert.deepEqual(
    harness.cookieWrites,
    [],
  );
});

test("active TOTP requires a valid code and durable replay claim", async () => {
  for (const scenario of [
    {
      proof: {
        password:
          "synthetic-current-password",
      },
    },
    { totpValid: false },
    { replayAllowed: false },
  ]) {
    const harness =
      optionsHarness(scenario);
    if (scenario.proof) {
      harness.input.proof =
        scenario.proof;
    }
    const result =
      await harness.service
        .registrationOptions(
          harness.input,
        );
    assert.equal(
      result.code,
      "PASSKEY_FRESH_PROOF_REJECTED",
    );
    assert.equal(
      harness.events.includes(
        "CHALLENGE_ISSUE",
      ),
      false,
    );
  }
});

test("password alone is sufficient only when TOTP is absent", async () => {
  const harness = optionsHarness({
    active: false,
  });
  harness.input.proof = {
    password:
      "synthetic-current-password",
  };
  const result =
    await harness.service
      .registrationOptions(
        harness.input,
      );
  assert.equal(result.kind, "success");
  assert.equal(
    harness.events.includes("TOTP_PROOF"),
    false,
  );
  assert.equal(
    harness.events.includes(
      "TOTP_REPLAY_CLAIM",
    ),
    false,
  );
});

test("recovery credential cannot substitute for enrollment fresh proof", () => {
  assert.doesNotMatch(
    pluginSource,
    /recoveryCode|verifyRecovery|consumeRecovery/i,
  );
  assert.match(
    pluginSource,
    /verifyPasskeyManagementFreshProof/,
  );
});

test("rate rejection and rate storage failure issue no challenge", async () => {
  for (const overrides of [
    {
      limitFailure:
        "registrationOptions",
      code: "PASSKEY_RATE_LIMITED",
    },
    {
      limitFailure:
        "managementFreshProof",
      code: "PASSKEY_RATE_LIMITED",
    },
    {
      limitInfrastructure:
        "registrationOptions",
      code: "PASSKEY_UNAVAILABLE",
    },
  ]) {
    const harness =
      optionsHarness(overrides);
    const result =
      await harness.service
        .registrationOptions(
          harness.input,
        );
    assert.equal(result.code, overrides.code);
    assert.equal(
      harness.events.includes(
        "CHALLENGE_ISSUE",
      ),
      false,
    );
  }
});

test("successful registration commits before lookup clear and creates no session", async () => {
  const harness = verifyHarness();
  const result =
    await harness.service
      .registrationVerify(
        harness.input,
      );
  assert.equal(result.kind, "success");
  assert.deepEqual(harness.events, [
    "LIMIT:registrationVerify:network",
    "LIMIT:registrationVerify:user",
    "TX_BEGIN",
    "CHALLENGE_CLAIM",
    "VERIFY_REGISTRATION",
    "CREDENTIAL_INSERT",
    "TX_COMMIT",
    "LOOKUP_COOKIE_CLEAR",
  ]);
  assert.equal(harness.challengePresent, false);
  assert.equal(harness.credentialPresent, true);
  assert.deepEqual(plain(result.passkey), {
    id: "synthetic-passkey-id",
    name: "Synthetic key",
    deviceType: "multiDevice",
    backedUp: true,
  });
  assert.doesNotMatch(
    pluginSource,
    /createSession|setSessionCookie/,
  );
});

test("registration selector hook receives the exact transaction adapter before challenge claim", async () => {
  const harness = verifyHarness(
    "success",
    async () => undefined,
  );
  const result = await harness.service.registrationVerify(harness.input);
  assert.equal(result.kind, "success");
  assert.ok(
    harness.events.indexOf("SELECTOR_BIND") >
      harness.events.indexOf("TX_BEGIN"),
  );
  assert.ok(
    harness.events.indexOf("SELECTOR_BIND") <
      harness.events.indexOf("CHALLENGE_CLAIM"),
  );
});

test("registration selector bind failure rolls back before challenge or credential mutation", async () => {
  const harness = verifyHarness(
    "success",
    async () => {
      throw new Error("synthetic selector bind failure");
    },
  );
  const result = await harness.service.registrationVerify(harness.input);
  assert.equal(result.code, "PASSKEY_UNAVAILABLE");
  assert.ok(harness.events.includes("TX_ROLLBACK"));
  assert.equal(harness.events.includes("CHALLENGE_CLAIM"), false);
  assert.equal(harness.events.includes("CREDENTIAL_INSERT"), false);
});

test("hook-absent registration path performs no selector binding", async () => {
  const harness = verifyHarness();
  const result = await harness.service.registrationVerify(harness.input);
  assert.equal(result.kind, "success");
  assert.equal(harness.events.includes("SELECTOR_BIND"), false);
});

test("expected proof rejection commits challenge consumption then clears lookup", async () => {
  const harness =
    verifyHarness("proof-rejection");
  const result =
    await harness.service
      .registrationVerify(
        harness.input,
      );
  assert.equal(
    result.code,
    "PASSKEY_REQUEST_REJECTED",
  );
  assert.deepEqual(
    harness.events.slice(-3),
    [
      "VERIFY_REGISTRATION",
      "TX_COMMIT",
      "LOOKUP_COOKIE_CLEAR",
    ],
  );
  assert.equal(harness.challengePresent, false);
  assert.equal(harness.credentialPresent, false);
});

test("duplicate credential rolls back and preserves lookup without owner disclosure", async () => {
  const harness =
    verifyHarness("duplicate");
  const result =
    await harness.service
      .registrationVerify(
        harness.input,
      );
  assert.equal(
    result.code,
    "PASSKEY_CREDENTIAL_CONFLICT",
  );
  assert.equal(
    harness.events.at(-1),
    "TX_ROLLBACK",
  );
  assert.equal(harness.challengePresent, true);
  assert.equal(harness.credentialPresent, false);
  assert.equal(
    harness.events.includes(
      "LOOKUP_COOKIE_CLEAR",
    ),
    false,
  );
  assert.equal(
    JSON.stringify(result).includes("owner"),
    false,
  );
});

test("insert infrastructure failure rolls back and preserves retryable challenge", async () => {
  const harness =
    verifyHarness("insert-infrastructure");
  const result =
    await harness.service
      .registrationVerify(
        harness.input,
      );
  assert.equal(
    result.code,
    "PASSKEY_UNAVAILABLE",
  );
  assert.equal(
    harness.events.at(-1),
    "TX_ROLLBACK",
  );
  assert.equal(harness.challengePresent, true);
  assert.equal(harness.credentialPresent, false);
});

test("challenge storage infrastructure failure rolls back without cookie output", async () => {
  const harness =
    verifyHarness(
      "challenge-infrastructure",
    );
  const result =
    await harness.service
      .registrationVerify(
        harness.input,
      );
  assert.equal(
    result.code,
    "PASSKEY_UNAVAILABLE",
  );
  assert.equal(
    harness.events.at(-1),
    "TX_ROLLBACK",
  );
  assert.equal(harness.challengePresent, true);
  assert.equal(
    harness.events.includes(
      "LOOKUP_COOKIE_CLEAR",
    ),
    false,
  );
});

test("used or invalid challenge is one safe committed rejection", async () => {
  const harness = verifyHarness();
  await harness.service.registrationVerify(
    harness.input,
  );
  const result =
    await harness.service
      .registrationVerify(
        harness.input,
      );
  assert.equal(
    result.code,
    "PASSKEY_REQUEST_REJECTED",
  );
  assert.equal(
    JSON.stringify(result).includes(
      "expired",
    ),
    false,
  );
  assert.equal(
    JSON.stringify(result).includes(
      "used",
    ),
    false,
  );
});

test("same-user authority rejects a different session user before insert", async () => {
  const harness = verifyHarness();
  harness.input.session = {
    ...baseSession,
    user: {
      ...baseSession.user,
      id: "synthetic-user-b",
    },
  };
  const result =
    await harness.service
      .registrationVerify(
        harness.input,
      );
  assert.equal(
    result.code,
    "PASSKEY_REQUEST_REJECTED",
  );
  assert.equal(harness.credentialPresent, false);
  assert.equal(
    JSON.stringify(result).includes(
      "synthetic-user",
    ),
    false,
  );
});

test("failure before transaction claim produces no challenge or cookie mutation", async () => {
  const harness = verifyHarness("rate-limit");
  const result =
    await harness.service
      .registrationVerify(
        harness.input,
      );
  assert.equal(
    result.code,
    "PASSKEY_RATE_LIMITED",
  );
  assert.equal(
    harness.events.includes("TX_BEGIN"),
    false,
  );
  assert.equal(harness.challengePresent, true);
  assert.equal(
    harness.events.includes(
      "LOOKUP_COOKIE_CLEAR",
    ),
    false,
  );
});

test("registration verification reuses C1 ceremony and Better Auth transaction authority", () => {
  assert.match(
    pluginSource,
    /passkeyCeremonyServices\.verifyRegistration/,
  );
  assert.match(
    pluginSource,
    /runWithTransaction/,
  );
  assert.match(
    pluginSource,
    /getCurrentAdapter/,
  );
  assert.doesNotMatch(
    pluginSource,
    /@simplewebauthn\/server|verifyRegistrationResponse|expectedRPID|expectedOrigin/,
  );
});

test("production proof adapter reuses the accepted TOTP replay ledger", () => {
  assert.match(
    pluginSource,
    /app\.auth_totp_replay_guard/,
  );
  assert.match(
    pluginSource,
    /ON CONFLICT \(user_id, code_digest\)[\s\S]*DO NOTHING/,
  );
  assert.doesNotMatch(
    pluginSource,
    /CREATE TABLE|passkey_totp_replay|recovery_code/i,
  );
});

test("enrollment remains separated from authentication, management, assurance, and public mounting", () => {
  const enrollmentServiceStart =
    pluginSource.indexOf(
      "export function createPasskeyEnrollmentService",
    );
  const authenticationServiceStart =
    pluginSource.indexOf(
      "export function createPasskeyAuthenticationService",
    );
  assert.ok(enrollmentServiceStart >= 0);
  assert.ok(
    authenticationServiceStart >
      enrollmentServiceStart,
  );
  const enrollmentServiceSource =
    pluginSource.slice(
      enrollmentServiceStart,
      authenticationServiceStart,
    );
  assert.doesNotMatch(
    enrollmentServiceSource,
    /verifyAuthentication|authenticationOptions|authenticatePasskey|createSession|setSessionCookie/,
  );
  const plugin =
    pluginModule.passkeyPublicPlugin(
      { async query() { return { rowCount: 0, rows: [] }; } },
      {
        secret: "s".repeat(32),
        replayPepper: "t".repeat(32),
        recoveryPepper: "r".repeat(32),
        baseUrl: "https://example.test",
        trustedOrigins: ["https://example.test"],
        useSecureCookies: true,
        webauthn: baseConfig,
      },
    );
  assert.doesNotMatch(
    Function.prototype.toString.call(
      plugin.endpoints
        .deltaPasskeyEnrollmentOptions,
    ),
    /authenticationService|deltaPasskeyAuthentication/,
  );
  assert.doesNotMatch(
    Function.prototype.toString.call(
      plugin.endpoints
        .deltaPasskeyEnrollmentVerify,
    ),
    /authenticationService|deltaPasskeyAuthentication/,
  );
  assert.doesNotMatch(
    pluginSource,
    /createSession|setSessionCookie|listPasskeys|renamePasskey|deletePasskey|assuranceLevel|trustedDevice/,
  );
  assert.doesNotMatch(
    coreSource,
    /\/api\/v1\/auth\/passkeys/,
  );
});
