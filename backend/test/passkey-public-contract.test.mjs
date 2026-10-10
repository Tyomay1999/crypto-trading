import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import {
  createAuthEndpoint as realCreateAuthEndpoint,
  dispatchAuthEndpoint,
} from "better-auth/api";

const errorSource = readFileSync(
  "src/middleware/passkey-errors.ts",
  "utf8",
);
const routeSource = readFileSync(
  "src/routes/passkey.routes.ts",
  "utf8",
);
const appSource = readFileSync("src/app.ts", "utf8");
const serverSource = readFileSync("src/server.ts", "utf8");
const coreSource = readFileSync("src/auth/core.ts", "utf8");
const publicPluginSource = readFileSync(
  "src/auth/passkey-public-plugin.ts",
  "utf8",
);

class FakeAppError extends Error {
  constructor(statusCode, code, message, expose = true) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.expose = expose;
  }
}

class FakeBridgeCeremonyError extends Error {
  constructor(code) {
    super("Synthetic passkey ceremony failure.");
    this.code = code;
  }
}

function compileCommonJs(source, fileName, require) {
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName,
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, {
    exports: module.exports,
    module,
    require,
  });
  return module.exports;
}

const errorModule = compileCommonJs(
  errorSource,
  "passkey-errors.ts",
  (specifier) => {
    if (specifier === "../errors/app-error.js") {
      return { AppError: FakeAppError };
    }
    if (specifier === "./request-context.js") {
      return {
        getRequestId(response) {
          return response.locals?.requestId ?? "unknown";
        },
      };
    }
    throw new Error(`Unexpected error-module import: ${specifier}`);
  },
);

let lastRouter;
function fakeRouter() {
  const entries = [];
  const router = {
    entries,
    use(...handlers) {
      entries.push({ method: "USE", handlers });
      return router;
    },
    get(path, ...handlers) {
      entries.push({ method: "GET", path, handlers });
      return router;
    },
    post(path, ...handlers) {
      entries.push({ method: "POST", path, handlers });
      return router;
    },
  };
  lastRouter = router;
  return router;
}

const routeModule = compileCommonJs(
  routeSource,
  "passkey.routes.ts",
  (specifier) => {
    if (specifier === "express") return { Router: fakeRouter };
    if (specifier === "better-auth/node") {
      return {
        fromNodeHeaders(headers) {
          const output = new Headers();
          for (const [name, value] of Object.entries(headers)) {
            if (typeof value === "string") output.set(name, value);
          }
          return output;
        },
      };
    }
    if (specifier === "../auth/password-policy.js") {
      return { AUTH_PASSWORD_MAX_LENGTH: 128 };
    }
    if (specifier === "../middleware/passkey-errors.js") {
      return errorModule;
    }
    if (specifier === "../middleware/request-context.js") {
      return {
        getRequestId(response) {
          return response.locals?.requestId ?? "unknown";
        },
      };
    }
    if (specifier === "../middleware/require-session.js") {
      return {
        getCurrentSessionContext(response) {
          if (!response.locals?.currentSession) {
            throw new Error("missing synthetic session");
          }
          return response.locals.currentSession;
        },
      };
    }
    throw new Error(`Unexpected route-module import: ${specifier}`);
  },
);

let bridgeLimiterMode = "allow";
let bridgeCeremonyMode = "success";
let bridgeRegistrationMode = "success";
let bridgeEndpointSession = null;
let bridgeAudits = [];
let bridgeRegistrationVerifyCallCount = 0;
let bridgeCommittedCredentialCount = 0;
let bridgePendingCredentialCount = 0;
let bridgeTransactionActive = false;
const bridgeTransactionAdapter = {};

const bridgePluginModule = compileCommonJs(
  publicPluginSource,
  "passkey-public-plugin.ts",
  (specifier) => {
    if (specifier === "@better-auth/core/context") {
      return {
        async getCurrentAdapter(adapter) {
          return bridgeTransactionActive
            ? bridgeTransactionAdapter
            : adapter;
        },
        async runWithTransaction(_adapter, fn) {
          assert.equal(bridgeTransactionActive, false);
          bridgeTransactionActive = true;
          bridgePendingCredentialCount = 0;
          try {
            const value = await fn();
            bridgeCommittedCredentialCount +=
              bridgePendingCredentialCount;
            return value;
          } finally {
            bridgePendingCredentialCount = 0;
            bridgeTransactionActive = false;
          }
        },
      };
    }
    if (specifier === "better-auth/api") {
      return {
        createAuthEndpoint: realCreateAuthEndpoint,
        async getSessionFromCtx() {
          return bridgeEndpointSession;
        },
      };
    }
    if (specifier === "./passkey-ceremony.js") {
      return {
        PasskeyCeremonyError: FakeBridgeCeremonyError,
        passkeyCeremonyServices: {
          async registrationOptions() {
            return { challenge: "synthetic-registration" };
          },
          async verifyRegistration(input) {
            bridgeRegistrationVerifyCallCount += 1;
            assert.equal(bridgeTransactionActive, true);
            if (bridgeRegistrationMode === "rejected") {
              throw new FakeBridgeCeremonyError(
                "REGISTRATION_REJECTED",
              );
            }
            if (bridgeRegistrationMode === "duplicate") {
              throw new FakeBridgeCeremonyError(
                "CREDENTIAL_CONFLICT",
              );
            }
            if (bridgeRegistrationMode === "transactionFailure") {
              bridgePendingCredentialCount += 1;
              throw new Error(
                "Synthetic transaction failure after pending insert.",
              );
            }
            if (bridgeRegistrationMode === "ownerMismatch") {
              bridgePendingCredentialCount += 1;
              return {
                passkeyId: "synthetic-passkey-id",
                userId: "synthetic-peer-owner",
                credentialID: "synthetic-credential-id",
                userVerified: true,
                credentialDeviceType: "singleDevice",
                credentialBackedUp: false,
                aaguid: null,
                transports: null,
              };
            }
            bridgePendingCredentialCount += 1;
            return {
              passkeyId: "synthetic-passkey-id",
              userId: input.userId,
              credentialID: "synthetic-credential-id",
              userVerified: true,
              credentialDeviceType: "singleDevice",
              credentialBackedUp: false,
              aaguid: null,
              transports: null,
            };
          },
          async authenticationOptions() {
            if (bridgeCeremonyMode === "unexpectedFailure") {
              throw new Error("Synthetic unexpected internal failure.");
            }
            return { challenge: "synthetic-authentication" };
          },
        },
      };
    }
    if (specifier === "./passkey-challenge.js") {
      return {
        clearPasskeyLookupCookie(context) {
          context.setHeader(
            "set-cookie",
            "delta-auth.delta_passkey_challenge=; Max-Age=0; Path=/api; HttpOnly; SameSite=Lax",
          );
        },
      };
    }
    if (specifier === "./passkey-management-proof.js") {
      return {
        createTrustedPasskeyManagementContext() {
          throw new Error("Synthetic management context is unused.");
        },
        async verifyPasskeyManagementFreshProof() {
          throw new Error("Synthetic management proof is unused.");
        },
      };
    }
    if (specifier === "./mfa-security-audit.js") {
      return {
        tryLogPasskeySecurityAuditEvent(
          requestId,
          action,
          outcome,
          metadata,
        ) {
          bridgeAudits.push({ requestId, action, outcome, metadata });
        },
      };
    }
    if (specifier === "../storage/passkey-rate-limit.js") {
      return {
        createPasskeyDurableRateLimiter() {
          return async () => {
            if (bridgeLimiterMode === "unavailable") {
              throw new Error("Synthetic limiter infrastructure failure.");
            }
            return bridgeLimiterMode !== "rateLimited";
          };
        },
      };
    }
    throw new Error(`Unexpected bridge-plugin import: ${specifier}`);
  },
);

const plain = (value) => JSON.parse(JSON.stringify(value));

const {
  PASSKEY_PUBLIC_PREFIX,
  PASSKEY_JSON_BODY_LIMIT,
  PASSKEY_PUBLIC_ROUTE_COUNT,
  PASSKEY_ROUTE_POLICIES,
  PASSKEY_COOKIE_ALLOWLIST_CLASSES,
  PASSKEY_COOKIE_ALLOWED_NAMES,
  appendValidatedPasskeyCookies,
  createPasskeyAuthenticationRouteOperations,
  createPasskeyEnrollmentRouteOperations,
  createPasskeyManagementRouteOperations,
  createPasskeyRouter,
  parseAuthenticationOptionsBody,
  parseAuthenticationVerifyBody,
  parsePasskeyDeleteBody,
  parsePasskeyId,
  parsePasskeyListBody,
  parsePasskeyRenameBody,
  parseRegistrationOptionsBody,
  parseRegistrationVerifyBody,
  preparePasskeyPublicResponse,
  projectAuthenticationSuccess,
  projectEnrollmentPasskey,
  projectManagedPasskey,
  projectPasskeyList,
  validatePasskeySetCookies,
} = routeModule;

function internalResponse(status, body, cookies = []) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      getSetCookie() {
        return [...cookies];
      },
    },
    async json() {
      return body;
    },
  };
}

const {
  PASSKEY_PUBLIC_GENERIC_MESSAGE,
  PASSKEY_SAFE_ERROR_CODES,
  PasskeyPublicError,
  createPasskeyPublicErrorEnvelope,
  passkeyErrorHandler,
  passkeySensitiveHeaders,
  serializePasskeyPublicError,
} = errorModule;

const operationNames = [
  "registrationOptions",
  "registrationVerify",
  "authenticationOptions",
  "authenticationVerify",
  "list",
  "rename",
  "delete",
];

function completeOperations(result) {
  return Object.fromEntries(
    operationNames.map((name) => [
      name,
      async () => result ?? {
        kind: "error",
        code: "PASSKEY_UNAVAILABLE",
        setCookies: [],
      },
    ]),
  );
}

const managementSecurity = Object.freeze({
  requireSession(_request, _response, next) { next?.(); },
  requireTrustedOrigin(_request, _response, next) { next?.(); },
});

async function runAuthenticationOptionsBridgeScenario({
  limiterMode,
  ceremonyMode = "success",
}) {
  bridgeLimiterMode = limiterMode;
  bridgeCeremonyMode = ceremonyMode;
  bridgeAudits = [];

  const plugin = bridgePluginModule.passkeyPublicPlugin(
    { async query() { throw new Error("Direct database access is forbidden."); } },
    {
      recoveryPepper: "r".repeat(32),
      trustedOrigins: ["https://example.test"],
      webauthn: {
        rpId: "example.test",
        rpName: "Delta",
        origin: "https://example.test",
        userVerification: "required",
        attestation: "none",
        residentKey: "preferred",
        requireResidentKey: false,
        requireUserPresence: true,
      },
    },
  );
  const endpoint =
    plugin.endpoints.deltaPasskeyAuthenticationOptions;
  let internalStatus = null;
  const auth = {
    api: {
      async deltaPasskeyAuthenticationOptions(input) {
        const response = await dispatchAuthEndpoint(endpoint, {
          ...input,
          operationId: "deltaPasskeyAuthenticationOptions",
          context: {
            options: { plugins: [] },
            logger: { level: "silent" },
            adapter: {},
            session: null,
          },
          asResponse: true,
        });
        internalStatus = response.status;
        return response;
      },
      async deltaPasskeyAuthenticationVerify() {
        throw new Error("Synthetic authentication verifier is unused.");
      },
    },
  };
  const authenticationOperations =
    createPasskeyAuthenticationRouteOperations(auth);
  const router = createPasskeyRouter({
    operations: {
      ...completeOperations(),
      ...authenticationOperations,
    },
    secureCookies: false,
    managementSecurity,
  });
  const request = {
    body: {},
    headers: {
      "x-real-ip": "synthetic-network",
      "x-request-id": "attacker-controlled-request-id",
    },
  };
  const responseHeaders = new Map();
  const observed = { status: null, body: null };
  const response = {
    locals: { requestId: "server-request-id" },
    set(name, value) {
      responseHeaders.set(name.toLowerCase(), value);
      return this;
    },
    append(name, value) {
      responseHeaders.set(name.toLowerCase(), value);
      return this;
    },
    removeHeader(name) {
      responseHeaders.delete(name.toLowerCase());
    },
    status(value) {
      observed.status = value;
      return this;
    },
    json(value) {
      observed.body = value;
      return this;
    },
  };
  const sensitiveHeaders = router.entries.find(
    (entry) =>
      entry.method === "USE" &&
      entry.handlers.includes(passkeySensitiveHeaders),
  );
  const publicRoute = router.entries.find(
    (entry) =>
      entry.method === "POST" &&
      entry.path === "/authentication/options",
  );
  assert.ok(sensitiveHeaders);
  assert.ok(publicRoute);
  sensitiveHeaders.handlers[0](request, response, () => {});
  await publicRoute.handlers.at(-1)(request, response);
  return {
    audits: plain(bridgeAudits),
    internalStatus,
    observed: plain(observed),
    responseHeaders,
  };
}

test("real auth.api dispatch preserves a rate-limit decision at the public bridge", async () => {
  const result = await runAuthenticationOptionsBridgeScenario({
    limiterMode: "rateLimited",
  });
  assert.equal(result.internalStatus, 429);
  assert.equal(result.observed.status, 429);
  assert.deepEqual(result.observed.body, {
    error: {
      code: "PASSKEY_RATE_LIMITED",
      message: PASSKEY_PUBLIC_GENERIC_MESSAGE,
      requestId: "server-request-id",
    },
  });
  assert.equal(
    result.responseHeaders.get("cache-control"),
    "no-store",
  );
  assert.equal(
    result.responseHeaders.get("pragma"),
    "no-cache",
  );
  assert.equal(result.audits.length, 1);
  assert.equal(result.audits[0].action, "passkey_rate_limit");
  assert.equal(result.audits[0].outcome, "rate_limited");
});

test("real auth.api dispatch preserves limiter unavailability as 503", async () => {
  const result = await runAuthenticationOptionsBridgeScenario({
    limiterMode: "unavailable",
  });
  assert.equal(result.internalStatus, 503);
  assert.equal(result.observed.status, 503);
  assert.equal(
    result.observed.body.error.code,
    "PASSKEY_UNAVAILABLE",
  );
  assert.equal(
    result.observed.body.error.message,
    PASSKEY_PUBLIC_GENERIC_MESSAGE,
  );
  assert.equal(
    result.observed.body.error.requestId,
    "server-request-id",
  );
  assert.equal(
    result.audits.some(
      ({ action, outcome }) =>
        action === "passkey_rate_limit" || outcome === "rate_limited",
    ),
    false,
  );
});

test("real auth.api dispatch does not relabel an unexpected failure as rate limited", async () => {
  const result = await runAuthenticationOptionsBridgeScenario({
    limiterMode: "allow",
    ceremonyMode: "unexpectedFailure",
  });
  assert.equal(result.internalStatus, 503);
  assert.equal(result.observed.status, 503);
  assert.equal(
    result.observed.body.error.code,
    "PASSKEY_UNAVAILABLE",
  );
  assert.equal(
    result.audits.some(
      ({ action, outcome }) =>
        action === "passkey_rate_limit" || outcome === "rate_limited",
    ),
    false,
  );
});

const lookupSet =
  "delta-auth.delta_passkey_challenge=fake.lookup.value; Max-Age=300; Path=/api; HttpOnly; SameSite=Lax";
const lookupClear =
  "delta-auth.delta_passkey_challenge=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/api; HttpOnly; SameSite=Lax";
const sessionSet =
  "delta-auth.session_token=fake.session.value; Max-Age=604800; Path=/; HttpOnly; SameSite=Lax";
const sessionClear =
  "delta-auth.session_token=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax";
const secureLookupSet =
  "__Secure-delta-auth.delta_passkey_challenge=fake.lookup.value; Max-Age=300; Path=/api; HttpOnly; Secure; SameSite=Lax";
const secureSessionSet =
  "__Secure-delta-auth.session_token=fake.session.value; Max-Age=604800; Path=/; HttpOnly; Secure; SameSite=Lax";

async function runRegistrationVerifyBridgeScenario({
  mode = "success",
  initialCredentialCount = 0,
  sessionAvailable = true,
} = {}) {
  bridgeRegistrationMode = mode;
  bridgeEndpointSession =
    sessionAvailable
      ? {
          session: {
            id: "synthetic-session",
          },
          user: {
            id: "synthetic-owner",
            email: "person@example.test",
            name: "Synthetic Person",
          },
        }
      : null;
  bridgeAudits = [];
  bridgeRegistrationVerifyCallCount = 0;
  bridgeCommittedCredentialCount =
    initialCredentialCount;
  bridgePendingCredentialCount = 0;
  bridgeTransactionActive = false;

  const plugin = bridgePluginModule.passkeyPublicPlugin(
    {
      async query() {
        throw new Error(
          "Direct database access is forbidden.",
        );
      },
    },
    {
      secret: "s".repeat(32),
      replayPepper: "t".repeat(32),
      recoveryPepper: "r".repeat(32),
      baseUrl: "https://example.test",
      trustedOrigins: ["https://example.test"],
      useSecureCookies: false,
      webauthn: {
        rpId: "example.test",
        rpName: "Delta",
        origin: "https://example.test",
        userVerification: "required",
        attestation: "none",
        residentKey: "preferred",
        requireResidentKey: false,
        requireUserPresence: true,
      },
    },
  );
  const endpoint =
    plugin.endpoints.deltaPasskeyEnrollmentVerify;
  const adapter = {};
  let internalStatus = null;
  const auth = {
    api: {
      async deltaPasskeyEnrollmentOptions() {
        throw new Error(
          "Synthetic enrollment options are unused.",
        );
      },
      async deltaPasskeyEnrollmentVerify(input) {
        const response = await dispatchAuthEndpoint(
          endpoint,
          {
            ...input,
            operationId:
              "deltaPasskeyEnrollmentVerify",
            context: {
              options: { plugins: [] },
              logger: { level: "silent" },
              adapter,
              session: null,
              password: {
                async verify() {
                  throw new Error(
                    "Password verification is unused.",
                  );
                },
              },
            },
            asResponse: true,
          },
        );
        internalStatus = response.status;
        return response;
      },
    },
  };
  const enrollmentOperations =
    createPasskeyEnrollmentRouteOperations(
      auth,
    );
  const router = createPasskeyRouter({
    operations: {
      ...completeOperations(),
      ...enrollmentOperations,
    },
    secureCookies: false,
    managementSecurity,
  });
  const request = {
    body: {
      response: { id: "opaque" },
      name: "Work laptop",
    },
    headers: {
      cookie:
        "delta-auth.session_token=synthetic",
      origin: "https://example.test",
      "x-real-ip": "synthetic-network",
      "x-request-id":
        "attacker-controlled-request-id",
    },
  };
  const responseHeaders = new Map();
  const observed = {
    status: null,
    body: null,
  };
  const response = {
    locals: {
      requestId: "server-request-id",
    },
    set(name, value) {
      responseHeaders.set(
        name.toLowerCase(),
        value,
      );
      return this;
    },
    append(name, value) {
      responseHeaders.set(
        name.toLowerCase(),
        value,
      );
      return this;
    },
    removeHeader(name) {
      responseHeaders.delete(
        name.toLowerCase(),
      );
    },
    status(value) {
      observed.status = value;
      return this;
    },
    json(value) {
      observed.body = value;
      return this;
    },
  };
  const sensitiveHeaders =
    router.entries.find(
      (entry) =>
        entry.method === "USE" &&
        entry.handlers.includes(
          passkeySensitiveHeaders,
        ),
    );
  const publicRoute =
    router.entries.find(
      (entry) =>
        entry.method === "POST" &&
        entry.path ===
          "/registration/verify",
    );
  assert.ok(sensitiveHeaders);
  assert.ok(publicRoute);
  sensitiveHeaders.handlers[0](
    request,
    response,
    () => {},
  );
  try {
    await publicRoute.handlers.at(-1)(
      request,
      response,
    );
  } finally {
    bridgeEndpointSession = null;
  }
  return {
    audits: plain(bridgeAudits),
    committedCredentialCount:
      bridgeCommittedCredentialCount,
    internalStatus,
    observed: plain(observed),
    responseHeaders,
    verifyCallCount:
      bridgeRegistrationVerifyCallCount,
  };
}

test("real auth.api enrollment dispatch propagates one committed success as public 201", async () => {
  const result =
    await runRegistrationVerifyBridgeScenario();

  assert.equal(result.verifyCallCount, 1);
  assert.equal(
    result.committedCredentialCount,
    1,
  );
  assert.equal(result.internalStatus, 201);
  assert.equal(result.observed.status, 201);
  assert.deepEqual(result.observed.body, {
    passkey: {
      id: "synthetic-passkey-id",
      name: "Work laptop",
      deviceType: "singleDevice",
      backedUp: false,
    },
  });
  assert.equal(
    result.responseHeaders.get(
      "cache-control",
    ),
    "no-store",
  );
  assert.equal(
    result.responseHeaders.get("pragma"),
    "no-cache",
  );
  assert.match(
    result.responseHeaders.get("set-cookie"),
    /^delta-auth\.delta_passkey_challenge=;/,
  );
  assert.equal(result.audits.length, 1);
  assert.equal(
    result.audits[0].requestId,
    "server-request-id",
  );
  assert.equal(
    result.audits[0].action,
    "passkey_registration",
  );
  assert.equal(
    result.audits[0].outcome,
    "success",
  );
});

test("enrollment status propagation never promotes rejection, rollback, conflict, or owner mismatch", async () => {
  const scenarios = [
    {
      mode: "rejected",
      internalStatus: 400,
      publicStatus: 400,
      code: "PASSKEY_REQUEST_REJECTED",
      initialCredentialCount: 0,
      verifyCallCount: 1,
    },
    {
      mode: "duplicate",
      internalStatus: 409,
      publicStatus: 409,
      code: "PASSKEY_CREDENTIAL_CONFLICT",
      initialCredentialCount: 1,
      verifyCallCount: 1,
    },
    {
      mode: "transactionFailure",
      internalStatus: 503,
      publicStatus: 503,
      code: "PASSKEY_UNAVAILABLE",
      initialCredentialCount: 0,
      verifyCallCount: 1,
    },
    {
      mode: "ownerMismatch",
      internalStatus: 503,
      publicStatus: 503,
      code: "PASSKEY_UNAVAILABLE",
      initialCredentialCount: 0,
      verifyCallCount: 1,
    },
  ];

  for (const scenario of scenarios) {
    let result;
    try {
      result =
        await runRegistrationVerifyBridgeScenario(
          scenario,
        );
    } catch (error) {
      error.message =
        `${scenario.mode}: ${error.message}`;
      throw error;
    }
    assert.equal(
      result.internalStatus,
      scenario.internalStatus,
    );
    assert.equal(
      result.observed.status,
      scenario.publicStatus,
    );
    assert.notEqual(
      result.observed.status,
      201,
    );
    assert.deepEqual(
      result.observed.body,
      {
        error: {
          code: scenario.code,
          message:
            PASSKEY_PUBLIC_GENERIC_MESSAGE,
          requestId:
            "server-request-id",
        },
      },
    );
    assert.equal(
      result.committedCredentialCount,
      scenario.initialCredentialCount,
    );
    assert.equal(
      result.verifyCallCount,
      scenario.verifyCallCount,
    );
    assert.equal(
      result.responseHeaders.get(
        "cache-control",
      ),
      "no-store",
    );
    assert.equal(
      result.responseHeaders.get("pragma"),
      "no-cache",
    );
  }
});

test("a thrown enrollment bridge call remains unavailable and cannot become public 201", async () => {
  const operations =
    createPasskeyEnrollmentRouteOperations({
      api: {
        async deltaPasskeyEnrollmentOptions() {
          throw new Error("unused");
        },
        async deltaPasskeyEnrollmentVerify() {
          throw new Error(
            "Synthetic Better Auth bridge failure.",
          );
        },
      },
    });
  const result =
    await operations.registrationVerify({
      context: {
        headers: {},
        requestId:
          "server-request-id",
      },
      value: {
        response: { id: "opaque" },
      },
    });
  const prepared =
    preparePasskeyPublicResponse(
      "registrationVerify",
      result,
      false,
      "server-request-id",
    );
  assert.equal(prepared.status, 503);
  assert.deepEqual(plain(prepared.body), {
    error: {
      code: "PASSKEY_UNAVAILABLE",
      message:
        PASSKEY_PUBLIC_GENERIC_MESSAGE,
      requestId:
        "server-request-id",
    },
  });
  assert.deepEqual(
    plain(prepared.setCookies),
    [],
  );
});

const enrollmentInternal = {
  id: "passkey-safe-id",
  name: "Work laptop",
  deviceType: "multiDevice",
  backedUp: true,
  credentialID: "CREDENTIAL_SECRET_SENTINEL",
  publicKey: "PUBLIC_KEY_SECRET_SENTINEL",
  counter: 42,
  aaguid: "AAGUID_SECRET_SENTINEL",
  transports: "TRANSPORT_SECRET_SENTINEL",
  fakeSecretField: "SECRET_SENTINEL",
};

const managementInternal = {
  ...enrollmentInternal,
  createdAt: "2026-09-11T12:00:00.000Z",
};

test("public route policy freezes exactly the seven PF1 method/path pairs", () => {
  assert.equal(PASSKEY_PUBLIC_PREFIX, "/api/v1/auth/passkeys");
  assert.equal(PASSKEY_PUBLIC_ROUTE_COUNT, 7);
  assert.equal(PASSKEY_ROUTE_POLICIES.length, 7);
  assert.deepEqual(
    plain(PASSKEY_ROUTE_POLICIES.map(({ method, path }) => ({ method, path }))),
    [
      { method: "POST", path: "/api/v1/auth/passkeys/registration/options" },
      { method: "POST", path: "/api/v1/auth/passkeys/registration/verify" },
      { method: "POST", path: "/api/v1/auth/passkeys/authentication/options" },
      { method: "POST", path: "/api/v1/auth/passkeys/authentication/verify" },
      { method: "GET", path: "/api/v1/auth/passkeys" },
      { method: "POST", path: "/api/v1/auth/passkeys/:id/rename" },
      { method: "POST", path: "/api/v1/auth/passkeys/:id/delete" },
    ],
  );
  assert.equal(PASSKEY_ROUTE_POLICIES.some(({ method }) => method === "PATCH"), false);
  assert.equal(PASSKEY_ROUTE_POLICIES.some(({ method }) => method === "DELETE"), false);
});

test("router registers exactly seven operations and no method aliases", () => {
  createPasskeyRouter({
    operations: completeOperations(),
    secureCookies: false,
    managementSecurity,
  });
  const routes = lastRouter.entries.filter(({ method }) => method !== "USE");
  assert.equal(routes.length, 7);
  assert.deepEqual(
    routes.map(({ method, path }) => `${method} ${path}`),
    [
      "POST /registration/options",
      "POST /registration/verify",
      "POST /authentication/options",
      "POST /authentication/verify",
      "GET /",
      "POST /:id/rename",
      "POST /:id/delete",
    ],
  );
});

test("management routes install the exact session and trusted-origin policy", () => {
  createPasskeyRouter({
    operations: completeOperations(),
    secureCookies: false,
    managementSecurity,
  });
  const routes = Object.fromEntries(
    lastRouter.entries
      .filter(({ method }) => method !== "USE")
      .map((entry) => [`${entry.method} ${entry.path}`, entry]),
  );
  assert.deepEqual(routes["GET /"]?.handlers.slice(0, 1), [managementSecurity.requireSession]);
  assert.deepEqual(routes["POST /:id/rename"]?.handlers.slice(0, 2), [
    managementSecurity.requireTrustedOrigin,
    managementSecurity.requireSession,
  ]);
  assert.deepEqual(routes["POST /:id/delete"]?.handlers.slice(0, 2), [
    managementSecurity.requireTrustedOrigin,
    managementSecurity.requireSession,
  ]);
});

test("I6 mounts the exact public router once before canonical application fallthrough", () => {
  assert.equal(
    (appSource.match(/createPasskeyRouter\s*\(/g) ?? []).length,
    1,
  );
  assert.equal(
    (appSource.match(/app\.use\(\s*PASSKEY_PUBLIC_PREFIX,/g) ?? []).length,
    2,
  );
  assert.ok(
    appSource.indexOf("createPasskeyRouter({") <
      appSource.indexOf("app.use(notFoundMiddleware)"),
  );
  assert.equal(PASSKEY_PUBLIC_ROUTE_COUNT, 7);
  assert.equal(
    new Set(PASSKEY_ROUTE_POLICIES.map(({ method, path }) => `${method} ${path}`)).size,
    7,
  );
  assert.doesNotMatch(
    appSource,
    /router\.(?:get|post)|deleteOwnedPasskeyWithLastLoginGuard|verifyPasskeyManagementFreshProof/,
  );
  assert.doesNotMatch(coreSource, /delta-passkey\/management/);
  assert.doesNotMatch(serverSource, /createPasskeyRouter|passkeyRoutes/);
  assert.equal(
    createHash("sha256").update(serverSource).digest("hex"),
    "c3cdb3068032383a990f4592fc673bd775d23e34e1f6cabd1999e6a7617a1034",
  );
});

test("missing operation dependencies fail closed at construction", () => {
  const operations = completeOperations();
  delete operations.authenticationVerify;
  assert.throws(
    () => createPasskeyRouter({ operations, secureCookies: false, managementSecurity }),
    /dependencies are incomplete/,
  );
  assert.throws(
    () => createPasskeyRouter({ operations: completeOperations() }),
    /dependencies are incomplete/,
  );
});

test("management route operations use authoritative session context and emit no cookies", async () => {
  const calls = [];
  const operations = createPasskeyManagementRouteOperations({
    async list(input) {
      calls.push(["list", input]);
      return { kind: "success", value: [] };
    },
    async rename(input) {
      calls.push(["rename", input]);
      return { kind: "success", value: managementInternal };
    },
    async remove(input) {
      calls.push(["delete", input]);
      return { kind: "success", value: undefined };
    },
  });
  const context = {
    headers: {
      origin: "https://example.test",
      "x-real-ip": "synthetic-network",
    },
    requestId: "request-synthetic",
    currentSession: {
      sessionId: "session-authoritative",
      userId: "user-authoritative",
    },
  };
  const listed = await operations.list({ context, value: undefined });
  const renamed = await operations.rename({
    context,
    value: { id: "target", name: "Renamed" },
  });
  const deleted = await operations.delete({
    context,
    value: { id: "target", proof: { password: "synthetic-password" } },
  });
  assert.deepEqual(plain([listed.setCookies, renamed.setCookies, deleted.setCookies]), [[], [], []]);
  assert.equal(calls.every(([, input]) => input.session.userId === "user-authoritative"), true);
  assert.equal(calls[2][1].networkSource, "synthetic-network");
  assert.equal(calls[2][1].requestOrigin, "https://example.test");
});

test("registration options accepts only a strict fresh-proof wrapper", () => {
  assert.deepEqual(
    plain(parseRegistrationOptionsBody({ password: "synthetic-password" })),
    { password: "synthetic-password" },
  );
  assert.deepEqual(
    plain(parseRegistrationOptionsBody({
      password: "synthetic-password",
      totpCode: "123456",
    })),
    { password: "synthetic-password", totpCode: "123456" },
  );
  for (const value of [null, [], "value", 1, {}, {
    password: "synthetic-password",
    extra: true,
  }, {
    password: "synthetic-password",
    totpCode: "12345x",
  }]) {
    assert.throws(() => parseRegistrationOptionsBody(value));
  }
});

test("registration verification preserves the opaque nested browser response", () => {
  const response = {
    id: "synthetic-browser-field",
    response: { nested: ["preserved"] },
    clientExtensionResults: { futureField: true },
  };
  const parsed = parseRegistrationVerifyBody({ response, name: "Security key" });
  assert.equal(parsed.response, response);
  assert.equal(parsed.name, "Security key");
  for (const value of [null, [], {}, { response: [] }, {
    response,
    name: " Security key",
  }, {
    response,
    unexpected: true,
  }]) {
    assert.throws(() => parseRegistrationVerifyBody(value));
  }
});

test("authentication options accepts exactly an empty object and no identity hint", () => {
  assert.deepEqual(plain(parseAuthenticationOptionsBody({})), {});
  for (const value of [
    null,
    [],
    "",
    { email: "synthetic@example.invalid" },
    { userId: "synthetic-user" },
    { username: "synthetic-user" },
    { credentialId: "synthetic-credential" },
    { arbitrary: true },
  ]) {
    assert.throws(() => parseAuthenticationOptionsBody(value));
  }
});

test("authentication verification accepts one opaque response field only", () => {
  const response = { authenticatorAttachment: "platform", opaque: { x: 1 } };
  const parsed = parseAuthenticationVerifyBody({ response });
  assert.equal(parsed.response, response);
  for (const value of [null, [], {}, { response: [] }, {
    response,
    userId: "forbidden",
  }]) {
    assert.throws(() => parseAuthenticationVerifyBody(value));
  }
});

test("list contract accepts no request body", () => {
  assert.equal(parsePasskeyListBody(undefined), undefined);
  for (const value of [null, {}, [], ""]) {
    assert.throws(() => parsePasskeyListBody(value));
  }
});

test("rename enforces the accepted 64-character trimmed control-free name", () => {
  assert.deepEqual(plain(parsePasskeyRenameBody({ name: "x".repeat(64) })), {
    name: "x".repeat(64),
  });
  for (const name of ["", " name", "name ", "x".repeat(65), "bad\nname"]) {
    assert.throws(() => parsePasskeyRenameBody({ name }));
  }
  assert.throws(() => parsePasskeyRenameBody({ name: "valid", extra: true }));
});

test("opaque route id is bounded, nonempty, trimmed and control-free", () => {
  assert.equal(parsePasskeyId("opaque-id"), "opaque-id");
  assert.equal(parsePasskeyId("x".repeat(256)).length, 256);
  for (const value of ["", " id", "id ", "x".repeat(257), "bad\nid", null]) {
    assert.throws(() => parsePasskeyId(value));
  }
});

test("delete body is the same strict non-reusable fresh-proof shape", () => {
  assert.deepEqual(
    plain(parsePasskeyDeleteBody({
      password: "synthetic-password",
      totpCode: "654321",
    })),
    { password: "synthetic-password", totpCode: "654321" },
  );
  assert.throws(() => parsePasskeyDeleteBody({ password: "synthetic-password", token: "no" }));
  assert.throws(() => parsePasskeyDeleteBody({
    password: "synthetic-password",
    recoveryCode: "synthetic-recovery-code",
  }));
});

test("enrollment projection is a field allowlist", () => {
  assert.deepEqual(plain(projectEnrollmentPasskey(enrollmentInternal)), {
    id: "passkey-safe-id",
    name: "Work laptop",
    deviceType: "multiDevice",
    backedUp: true,
  });
  const serialized = JSON.stringify(projectEnrollmentPasskey(enrollmentInternal));
  for (const sentinel of [
    "CREDENTIAL_SECRET_SENTINEL",
    "PUBLIC_KEY_SECRET_SENTINEL",
    "AAGUID_SECRET_SENTINEL",
    "TRANSPORT_SECRET_SENTINEL",
    "SECRET_SENTINEL",
  ]) {
    assert.equal(serialized.includes(sentinel), false);
  }
});

test("management projection adds only canonical createdAt", () => {
  assert.deepEqual(plain(projectManagedPasskey(managementInternal)), {
    id: "passkey-safe-id",
    name: "Work laptop",
    deviceType: "multiDevice",
    backedUp: true,
    createdAt: "2026-09-11T12:00:00.000Z",
  });
  assert.throws(() => projectManagedPasskey({ ...managementInternal, createdAt: "not-a-date" }));
});

test("list projection supports empty arrays and strips every internal field", () => {
  assert.deepEqual(plain(projectPasskeyList([])), []);
  const output = projectPasskeyList([managementInternal]);
  assert.equal(output.length, 1);
  assert.equal(JSON.stringify(output).includes("SECRET_SENTINEL"), false);
  assert.throws(() => projectPasskeyList({}));
});

test("authentication success projector emits exactly status true", () => {
  const output = projectAuthenticationSuccess({
    status: true,
    userId: "USER_SECRET_SENTINEL",
    email: "EMAIL_SECRET_SENTINEL",
    session: "SESSION_SECRET_SENTINEL",
    token: "TOKEN_SECRET_SENTINEL",
    credential: "CREDENTIAL_SECRET_SENTINEL",
  });
  assert.deepEqual(plain(output), { status: true });
  assert.throws(() => projectAuthenticationSuccess({ status: false }));
});

test("delete success prepares status 204 with no body", () => {
  const prepared = preparePasskeyPublicResponse(
    "delete",
    { kind: "success", value: undefined, setCookies: [] },
    false,
    "request-synthetic",
  );
  assert.equal(prepared.status, 204);
  assert.equal(prepared.body, undefined);
  assert.throws(() => preparePasskeyPublicResponse(
    "delete",
    { kind: "success", value: null, setCookies: [] },
    false,
    "request-synthetic",
  ));
});

test("all finite error codes serialize to the stable generic envelope", () => {
  const expectedStatuses = {
    PASSKEY_REQUEST_REJECTED: 400,
    PASSKEY_RATE_LIMITED: 429,
    PASSKEY_FRESH_PROOF_REJECTED: 401,
    PASSKEY_CREDENTIAL_CONFLICT: 409,
    PASSKEY_UNAVAILABLE: 503,
    PASSKEY_NOT_FOUND: 404,
    PASSKEY_LAST_LOGIN_METHOD_REQUIRED: 409,
  };
  assert.equal(PASSKEY_SAFE_ERROR_CODES.length, 7);
  for (const code of PASSKEY_SAFE_ERROR_CODES) {
    const serialized = serializePasskeyPublicError(
      new PasskeyPublicError(code),
      "request-synthetic",
    );
    assert.equal(serialized.status, expectedStatuses[code]);
    assert.deepEqual(plain(serialized.body), {
      error: {
        code,
        message: PASSKEY_PUBLIC_GENERIC_MESSAGE,
        requestId: "request-synthetic",
      },
    });
  }
});

test("raw WebAuthn, database, Better Auth and stack sentinels never serialize", () => {
  const sentinels = [
    "SIMPLEWEBAUTHN_SECRET_SENTINEL",
    "POSTGRES_SECRET_SENTINEL",
    "BETTER_AUTH_SECRET_SENTINEL",
    "STACK_SECRET_SENTINEL",
  ];
  for (const sentinel of sentinels) {
    const error = new Error(sentinel);
    error.stack = sentinel;
    error.code = sentinel;
    error.constraint = sentinel;
    const output = serializePasskeyPublicError(error, "request-synthetic");
    assert.equal(output.status, 503);
    assert.equal(JSON.stringify(output).includes(sentinel), false);
  }
});

test("not-found envelope contains no requested id or ownership distinction", () => {
  const first = createPasskeyPublicErrorEnvelope("PASSKEY_NOT_FOUND", "request-one");
  const second = createPasskeyPublicErrorEnvelope("PASSKEY_NOT_FOUND", "request-two");
  assert.equal(first.error.code, second.error.code);
  assert.equal(first.error.message, second.error.message);
  assert.equal(JSON.stringify(first).includes("requested-passkey-id"), false);
});

test("sensitive middleware applies no-store and no-cache before continuation", () => {
  const events = [];
  const request = { headers: { "x-request-id": "attacker-correlation" } };
  const response = {
    set(name, value) {
      events.push(`${name}:${value}`);
    },
  };
  passkeySensitiveHeaders(request, response, () => events.push("next"));
  assert.deepEqual(events, [
    "Cache-Control:no-store",
    "Pragma:no-cache",
    "next",
  ]);
  assert.equal("x-request-id" in request.headers, false);
});

test("error middleware removes cookies and emits only the sanitized envelope", () => {
  const events = [];
  const response = {
    locals: { requestId: "request-synthetic" },
    removeHeader(name) { events.push(`remove:${name}`); },
    set(name, value) { events.push(`set:${name}:${value}`); },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; events.push("json"); return this; },
  };
  passkeyErrorHandler(new Error("STACK_SECRET_SENTINEL"), {}, response, () => {});
  assert.equal(response.statusCode, 503);
  assert.equal(JSON.stringify(response.body).includes("STACK_SECRET_SENTINEL"), false);
  assert.deepEqual(events.slice(0, 3), [
    "remove:Set-Cookie",
    "set:Cache-Control:no-store",
    "set:Pragma:no-cache",
  ]);
});

test("cookie allowlist contains only accepted Delta lookup and session names", () => {
  assert.deepEqual(plain(PASSKEY_COOKIE_ALLOWLIST_CLASSES), [
    "PASSKEY_LOOKUP_COOKIE",
    "BETTER_AUTH_AUTH_SESSION_COOKIE",
    "BETTER_AUTH_SESSION_REFRESH_OR_STALE_CLEAR_COOKIE",
  ]);
  assert.deepEqual(plain(PASSKEY_COOKIE_ALLOWED_NAMES), [
    "delta-auth.delta_passkey_challenge",
    "__Secure-delta-auth.delta_passkey_challenge",
    "delta-auth.session_token",
    "__Secure-delta-auth.session_token",
  ]);
});

test("lookup cookie set and clear require exact class action and attributes", () => {
  assert.equal(validatePasskeySetCookies(
    [lookupSet],
    [{ cookieClass: "lookup", action: "set" }],
    false,
  ).length, 1);
  assert.equal(validatePasskeySetCookies(
    [lookupClear],
    [{ cookieClass: "lookup", action: "clear" }],
    false,
  ).length, 1);
  assert.throws(() => validatePasskeySetCookies(
    [lookupSet],
    [{ cookieClass: "lookup", action: "clear" }],
    false,
  ));
});

test("secure cookie policy requires both secure name prefix and attribute", () => {
  assert.equal(validatePasskeySetCookies(
    [secureLookupSet],
    [{ cookieClass: "lookup", action: "set" }],
    true,
  ).length, 1);
  assert.equal(validatePasskeySetCookies(
    [secureSessionSet],
    [{ cookieClass: "authSession", action: "set" }],
    true,
  ).length, 1);
  assert.throws(() => validatePasskeySetCookies(
    [secureLookupSet],
    [{ cookieClass: "lookup", action: "set" }],
    false,
  ));
  assert.throws(() => validatePasskeySetCookies(
    [lookupSet],
    [{ cookieClass: "lookup", action: "set" }],
    true,
  ));
});

test("session cookie accepts set and stale-clear contracts without duplication", () => {
  assert.equal(validatePasskeySetCookies(
    [sessionSet],
    [{ cookieClass: "authSession", action: "set" }],
    false,
  ).length, 1);
  assert.equal(validatePasskeySetCookies(
    [sessionClear],
    [{ cookieClass: "authSession", action: "clear" }],
    false,
  ).length, 1);
  assert.throws(() => validatePasskeySetCookies(
    [sessionSet, sessionSet],
    [{ cookieClass: "authSession", action: "set" }],
    false,
  ));
});

test("cookie validator rejects arbitrary, broadened, non-HttpOnly and wrong-path cookies", () => {
  const invalid = [
    "arbitrary.cookie=fake; Path=/; HttpOnly; SameSite=Lax",
    "delta-auth.session_token=fake; Path=/; HttpOnly; SameSite=Lax; Domain=example.invalid",
    "delta-auth.session_token=fake; Path=/; SameSite=Lax",
    "delta-auth.session_token=fake; Path=/api; HttpOnly; SameSite=Lax",
    "delta-auth.session_token=fake; Path=/; HttpOnly; SameSite=None",
    "delta-auth.session_token=fake; Path=/; HttpOnly; SameSite=Lax; Priority=High",
  ];
  for (const cookie of invalid) {
    assert.throws(() => validatePasskeySetCookies(
      [cookie],
      [{ cookieClass: "authSession", action: "set" }],
      false,
    ));
  }
});

test("Expires comma is preserved within one framework-provided cookie entry", () => {
  const validated = validatePasskeySetCookies(
    [lookupClear],
    [{ cookieClass: "lookup", action: "clear" }],
    false,
  );
  assert.equal(validated.length, 1);
  assert.equal(validated[0], lookupClear);
});

test("invalid internal body never produces an appendable response", () => {
  const appended = [];
  assert.throws(() => {
    const prepared = preparePasskeyPublicResponse(
      "registrationVerify",
      { kind: "success", value: { malformed: true }, setCookies: [lookupClear] },
      false,
      "request-synthetic",
    );
    appendValidatedPasskeyCookies({
      append(_name, value) { appended.push(value); },
    }, prepared);
  });
  assert.deepEqual(appended, []);
});

test("valid body with an unexpected cookie is rejected before forwarding", () => {
  const appended = [];
  assert.throws(() => {
    const prepared = preparePasskeyPublicResponse(
      "registrationVerify",
      { kind: "success", value: enrollmentInternal, setCookies: [sessionSet] },
      false,
      "request-synthetic",
    );
    appendValidatedPasskeyCookies({
      append(_name, value) { appended.push(value); },
    }, prepared);
  });
  assert.deepEqual(appended, []);
});

test("fully validated authentication success is eligible for exact cookie forwarding", () => {
  const prepared = preparePasskeyPublicResponse(
    "authenticationVerify",
    {
      kind: "success",
      value: { status: true, token: "TOKEN_SECRET_SENTINEL" },
      setCookies: [lookupClear, sessionSet],
    },
    false,
    "request-synthetic",
  );
  assert.equal(prepared.status, 200);
  assert.deepEqual(plain(prepared.body), { status: true });
  assert.equal(JSON.stringify(prepared.body).includes("TOKEN_SECRET_SENTINEL"), false);
  const appended = [];
  appendValidatedPasskeyCookies({
    append(name, value) { appended.push({ name, value }); },
  }, prepared);
  assert.equal(appended.length, 2);
  assert.equal(appended.every(({ name }) => name === "Set-Cookie"), true);
});

test("committed verification rejection permits lookup clear only", () => {
  const prepared = preparePasskeyPublicResponse(
    "authenticationVerify",
    {
      kind: "error",
      code: "PASSKEY_REQUEST_REJECTED",
      setCookies: [lookupClear],
    },
    false,
    "request-synthetic",
  );
  assert.equal(prepared.status, 400);
  assert.equal(prepared.setCookies.length, 1);
  assert.throws(() => preparePasskeyPublicResponse(
    "authenticationVerify",
    {
      kind: "error",
      code: "PASSKEY_REQUEST_REJECTED",
      setCookies: [lookupClear, sessionSet],
    },
    false,
    "request-synthetic",
  ));
});

test("infrastructure failure forwards no internal cookie", () => {
  const prepared = preparePasskeyPublicResponse(
    "authenticationVerify",
    {
      kind: "error",
      code: "PASSKEY_UNAVAILABLE",
      setCookies: [],
    },
    false,
    "request-synthetic",
  );
  assert.equal(prepared.status, 503);
  assert.deepEqual(plain(prepared.setCookies), []);
  assert.throws(() => preparePasskeyPublicResponse(
    "authenticationVerify",
    {
      kind: "error",
      code: "PASSKEY_UNAVAILABLE",
      setCookies: [lookupClear],
    },
    false,
    "request-synthetic",
  ));
});

test("success projectors and cookie contracts are route-specific", () => {
  const options = preparePasskeyPublicResponse(
    "authenticationOptions",
    { kind: "success", value: { rpId: "synthetic" }, setCookies: [lookupSet] },
    false,
    "request-synthetic",
  );
  assert.deepEqual(plain(options.body), { options: { rpId: "synthetic" } });

  const enrolled = preparePasskeyPublicResponse(
    "registrationVerify",
    { kind: "success", value: enrollmentInternal, setCookies: [lookupClear] },
    false,
    "request-synthetic",
  );
  assert.equal(enrolled.status, 201);
  assert.deepEqual(plain(enrolled.body), {
    passkey: {
      id: "passkey-safe-id",
      name: "Work laptop",
      deviceType: "multiDevice",
      backedUp: true,
    },
  });

  const listed = preparePasskeyPublicResponse(
    "list",
    { kind: "success", value: [], setCookies: [] },
    false,
    "request-synthetic",
  );
  assert.deepEqual(plain(listed.body), { passkeys: [] });
});

test("route security manifest preserves every PF1 gate and rate class", () => {
  const policies = Object.fromEntries(
    PASSKEY_ROUTE_POLICIES.map((policy) => [policy.operation, plain(policy)]),
  );
  assert.equal(policies.registrationOptions.authentication, "required");
  assert.equal(policies.registrationOptions.trustedOrigin, true);
  assert.equal(policies.registrationOptions.freshProof, true);
  assert.deepEqual(policies.registrationOptions.rateOperations, [
    "registrationOptions",
    "managementFreshProof",
  ]);
  assert.equal(policies.registrationVerify.authentication, "requiredSameSessionUser");
  assert.equal(policies.registrationVerify.freshProof, false);
  assert.deepEqual(policies.authenticationOptions.rateOperations, ["authenticationOptions"]);
  assert.equal(policies.authenticationOptions.rateIdentity, "networkOnly");
  assert.equal(policies.authenticationVerify.rateIdentity, "networkOnly");
  assert.equal(policies.list.trustedOrigin, false);
  assert.deepEqual(policies.list.rateOperations, ["managementList"]);
  assert.equal(policies.list.rateLimit, 60);
  assert.equal(policies.list.rateWindowSeconds, 60);
  assert.deepEqual(policies.rename.rateOperations, ["managementRename"]);
  assert.equal(policies.rename.rateLimit, 5);
  assert.equal(policies.rename.rateWindowSeconds, 900);
  assert.equal(policies.delete.freshProof, true);
  assert.deepEqual(policies.delete.rateOperations, [
    "managementFreshProof",
    "managementDelete",
  ]);
});

test("64kb body contract is wired to the scoped passkey parser without replacing normal-route parsing", () => {
  assert.equal(PASSKEY_JSON_BODY_LIMIT, "64kb");
  assert.equal(
    (appSource.match(/limit:\s*PASSKEY_JSON_BODY_LIMIT/g) ?? []).length,
    1,
  );
  assert.match(
    appSource,
    /normalDeltaJsonParser\s*=\s*express\.json\(\)/,
  );
  assert.match(appSource, /passkeyJsonParsed\s*===\s*true/);
});

test("I1 route layer contains no database, WebAuthn, auth core or C1 transaction implementation", () => {
  assert.doesNotMatch(routeSource, /from ["']pg["']|PoolClient|BEGIN|COMMIT|ROLLBACK/);
  assert.doesNotMatch(routeSource, /@simplewebauthn|verifyAuthenticationResponse|verifyRegistrationResponse/);
  assert.doesNotMatch(routeSource, /auth\/core|runWithTransaction|setSessionCookie|passkeyCeremonyServices/);
  assert.doesNotMatch(routeSource, /mfa-security-audit|passkey-rate-limit/);
});

test("enrollment route operations use exact programmatic auth.api methods with asResponse", async () => {
  const calls = [];
  const operations = createPasskeyEnrollmentRouteOperations({
    api: {
      async deltaPasskeyEnrollmentOptions(input) {
        calls.push({ operation: "options", input });
        return internalResponse(
          200,
          { options: { challenge: "synthetic" } },
          [lookupSet],
        );
      },
      async deltaPasskeyEnrollmentVerify(input) {
        calls.push({ operation: "verify", input });
        return internalResponse(
          201,
          { passkey: enrollmentInternal },
          [lookupClear],
        );
      },
    },
  });
  const context = {
    headers: {
      origin: "https://example.test",
      cookie: "synthetic-cookie",
      "x-real-ip": "synthetic-network",
      "x-request-id": "untrusted-overwritten",
    },
    requestId: "server-request-id",
  };
  const optionResult = await operations.registrationOptions({
    context,
    value: { password: "synthetic-password" },
  });
  const verifyResult = await operations.registrationVerify({
    context,
    value: { response: { id: "opaque" }, name: "Work laptop" },
  });
  assert.equal(optionResult.kind, "success");
  assert.equal(verifyResult.kind, "success");
  const preparedOptions = preparePasskeyPublicResponse(
    "registrationOptions",
    optionResult,
    false,
    context.requestId,
  );
  assert.equal(preparedOptions.status, 200);
  assert.deepEqual(plain(preparedOptions.setCookies), [lookupSet]);
  assert.deepEqual(calls.map(({ operation }) => operation), ["options", "verify"]);
  for (const { input } of calls) {
    assert.equal(input.asResponse, true);
    assert.equal(input.headers.get("x-request-id"), "server-request-id");
  }
  assert.deepEqual(plain(calls[0].input.body), {
    password: "synthetic-password",
  });
  assert.equal("userId" in calls[0].input.body, false);
  assert.equal("email" in calls[0].input.body, false);
});

test("enrollment bridge preserves safe success shapes for I1 validation", async () => {
  const operations = createPasskeyEnrollmentRouteOperations({
    api: {
      async deltaPasskeyEnrollmentOptions() {
        return internalResponse(
          200,
          { options: { challenge: "synthetic" } },
          [lookupSet],
        );
      },
      async deltaPasskeyEnrollmentVerify() {
        return internalResponse(
          201,
          { passkey: enrollmentInternal },
          [lookupClear],
        );
      },
    },
  });
  const context = { headers: {}, requestId: "server-request-id" };
  const internal = await operations.registrationVerify({
    context,
    value: { response: { id: "opaque" } },
  });
  const prepared = preparePasskeyPublicResponse(
    "registrationVerify",
    internal,
    false,
    context.requestId,
  );
  assert.equal(prepared.status, 201);
  assert.deepEqual(plain(prepared.body), {
    passkey: {
      id: "passkey-safe-id",
      name: "Work laptop",
      deviceType: "multiDevice",
      backedUp: true,
    },
  });
  assert.equal(JSON.stringify(prepared.body).includes("SECRET_SENTINEL"), false);
});

test("committed enrollment rejection retains lookup clear for exact cookie validation", async () => {
  const operations = createPasskeyEnrollmentRouteOperations({
    api: {
      async deltaPasskeyEnrollmentOptions() {
        throw new Error("unused");
      },
      async deltaPasskeyEnrollmentVerify() {
        return internalResponse(
          400,
          {
            error: {
              code: "PASSKEY_REQUEST_REJECTED",
              message: PASSKEY_PUBLIC_GENERIC_MESSAGE,
            },
          },
          [lookupClear],
        );
      },
    },
  });
  const result = await operations.registrationVerify({
    context: { headers: {}, requestId: "server-request-id" },
    value: { response: { id: "opaque" } },
  });
  const prepared = preparePasskeyPublicResponse(
    "registrationVerify",
    result,
    false,
    "server-request-id",
  );
  assert.equal(prepared.status, 400);
  assert.deepEqual(plain(prepared.setCookies), [lookupClear]);
});

test("malformed internal enrollment responses drop every cookie and fail closed", async () => {
  for (const response of [
    internalResponse(200, { unexpected: true }, [lookupSet]),
    internalResponse(201, { passkey: null }, [lookupClear]),
    internalResponse(
      409,
      {
        error: {
          code: "PASSKEY_CREDENTIAL_CONFLICT",
          message: "raw internal detail",
        },
      },
      [lookupClear],
    ),
    internalResponse(
      503,
      {
        error: {
          code: "PASSKEY_UNAVAILABLE",
          message: PASSKEY_PUBLIC_GENERIC_MESSAGE,
        },
      },
      [sessionSet],
    ),
  ]) {
    const operations = createPasskeyEnrollmentRouteOperations({
      api: {
        async deltaPasskeyEnrollmentOptions() {
          return response;
        },
        async deltaPasskeyEnrollmentVerify() {
          return response;
        },
      },
    });
    const result = await operations.registrationOptions({
      context: { headers: {}, requestId: "server-request-id" },
      value: { password: "synthetic-password" },
    });
    assert.equal(result.kind, "error");
    assert.equal(result.code, "PASSKEY_UNAVAILABLE");
    if (result.setCookies.length === 0) {
      const prepared = preparePasskeyPublicResponse(
        "registrationOptions",
        result,
        false,
        "server-request-id",
      );
      assert.deepEqual(plain(prepared.setCookies), []);
    } else {
      assert.throws(() =>
        preparePasskeyPublicResponse(
          "registrationOptions",
          result,
          false,
          "server-request-id",
        ),
      );
    }
  }
});

test("incomplete enrollment auth bridge fails at construction without synthetic success", () => {
  assert.throws(() =>
    createPasskeyEnrollmentRouteOperations({
      api: {
        deltaPasskeyEnrollmentOptions: async () =>
          internalResponse(200, {}, []),
      },
    }),
  );
});

test("authentication route operations use exact programmatic auth.api methods with asResponse", async () => {
  const calls = [];
  const operations = createPasskeyAuthenticationRouteOperations({
    api: {
      async deltaPasskeyAuthenticationOptions(input) {
        calls.push({ operation: "options", input });
        return internalResponse(
          200,
          { options: { challenge: "synthetic" } },
          [lookupSet],
        );
      },
      async deltaPasskeyAuthenticationVerify(input) {
        calls.push({ operation: "verify", input });
        return internalResponse(
          200,
          { status: true },
          [sessionSet, lookupClear],
        );
      },
    },
  });
  const context = {
    headers: {
      origin: "https://example.test",
      cookie: "synthetic-cookie",
      "x-real-ip": "synthetic-network",
      "x-request-id": "untrusted-overwritten",
    },
    requestId: "server-request-id",
  };
  await operations.authenticationOptions({
    context,
    value: {},
  });
  await operations.authenticationVerify({
    context,
    value: { response: { id: "opaque" } },
  });
  assert.deepEqual(
    calls.map(({ operation }) => operation),
    ["options", "verify"],
  );
  for (const { input } of calls) {
    assert.equal(input.asResponse, true);
    assert.equal(
      input.headers.get("x-request-id"),
      "server-request-id",
    );
  }
  assert.deepEqual(plain(calls[0].input.body), {});
  assert.equal("userId" in calls[0].input.body, false);
  assert.equal("email" in calls[0].input.body, false);
});

test("authentication bridge success validates exact option and auth-cookie contracts", async () => {
  const operations = createPasskeyAuthenticationRouteOperations({
    api: {
      async deltaPasskeyAuthenticationOptions() {
        return internalResponse(
          200,
          { options: { challenge: "synthetic" } },
          [lookupSet],
        );
      },
      async deltaPasskeyAuthenticationVerify() {
        return internalResponse(
          200,
          { status: true },
          [sessionSet, lookupClear],
        );
      },
    },
  });
  const context = {
    headers: {},
    requestId: "server-request-id",
  };
  const options = preparePasskeyPublicResponse(
    "authenticationOptions",
    await operations.authenticationOptions({
      context,
      value: {},
    }),
    false,
    context.requestId,
  );
  const verified = preparePasskeyPublicResponse(
    "authenticationVerify",
    await operations.authenticationVerify({
      context,
      value: { response: { id: "opaque" } },
    }),
    false,
    context.requestId,
  );
  assert.deepEqual(plain(options.body), {
    options: { challenge: "synthetic" },
  });
  assert.deepEqual(plain(options.setCookies), [lookupSet]);
  assert.deepEqual(plain(verified.body), { status: true });
  assert.deepEqual(
    plain(verified.setCookies),
    [sessionSet, lookupClear],
  );
});

test("committed authentication rejection permits lookup clear and no auth cookie", async () => {
  const operations = createPasskeyAuthenticationRouteOperations({
    api: {
      async deltaPasskeyAuthenticationOptions() {
        throw new Error("unused");
      },
      async deltaPasskeyAuthenticationVerify() {
        return internalResponse(
          400,
          {
            error: {
              code: "PASSKEY_REQUEST_REJECTED",
              message: PASSKEY_PUBLIC_GENERIC_MESSAGE,
            },
          },
          [lookupClear],
        );
      },
    },
  });
  const result = await operations.authenticationVerify({
    context: {
      headers: {},
      requestId: "server-request-id",
    },
    value: { response: { id: "opaque" } },
  });
  const prepared = preparePasskeyPublicResponse(
    "authenticationVerify",
    result,
    false,
    "server-request-id",
  );
  assert.equal(prepared.status, 400);
  assert.deepEqual(plain(prepared.setCookies), [lookupClear]);
});

test("malformed authentication bridge results fail closed before cookie forwarding", async () => {
  for (const response of [
    internalResponse(200, { unexpected: true }, [lookupSet]),
    internalResponse(200, { status: true, userId: "SECRET" }, [sessionSet, lookupClear]),
    internalResponse(200, { status: true }, [sessionSet, sessionSet, lookupClear]),
    internalResponse(200, { status: true }, [sessionSet, lookupClear, sessionClear]),
    internalResponse(
      503,
      {
        error: {
          code: "PASSKEY_UNAVAILABLE",
          message: PASSKEY_PUBLIC_GENERIC_MESSAGE,
        },
      },
      [sessionSet],
    ),
  ]) {
    const operations = createPasskeyAuthenticationRouteOperations({
      api: {
        async deltaPasskeyAuthenticationOptions() {
          return response;
        },
        async deltaPasskeyAuthenticationVerify() {
          return response;
        },
      },
    });
    const result = await operations.authenticationVerify({
      context: {
        headers: {},
        requestId: "server-request-id",
      },
      value: { response: { id: "opaque" } },
    });
    if (result.setCookies.length === 0) {
      assert.equal(result.kind, "error");
      assert.equal(result.code, "PASSKEY_UNAVAILABLE");
      continue;
    }
    assert.throws(() =>
      preparePasskeyPublicResponse(
        "authenticationVerify",
        result,
        false,
        "server-request-id",
      ),
    );
  }
});

test("incomplete authentication auth bridge fails at construction", () => {
  assert.throws(() =>
    createPasskeyAuthenticationRouteOperations({
      api: {
        deltaPasskeyAuthenticationOptions: async () =>
          internalResponse(200, {}, []),
      },
    }),
  );
});
