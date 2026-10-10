import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Duplex } from "node:stream";
import { IncomingMessage, ServerResponse } from "node:http";
import { gzipSync } from "node:zlib";
import test from "node:test";
import ts from "typescript";

const nativeRequire = createRequire(import.meta.url);
const backendRoot = resolve(".");
const appPath = resolve("src/app.ts");
const configPath = resolve("src/auth/config.ts");
const publicPluginPath = resolve(
  "src/auth/passkey-public-plugin.ts",
);
const appSource = readFileSync(appPath, "utf8");
const coreSource = readFileSync("src/auth/core.ts", "utf8");

const trustedOrigin = "https://delta.example";
const calls = {
  database: 0,
  administration: 0,
  administrationFactory: 0,
  enrollmentOptions: 0,
  enrollmentVerify: 0,
  authenticationOptions: 0,
  authenticationVerify: 0,
};

const database = {
  async query() {
    calls.database += 1;
    throw new Error("database access is forbidden in I6 composition tests");
  },
};

const safeInternalError = () =>
  new Response(
    JSON.stringify({
      error: {
        code: "PASSKEY_REQUEST_REJECTED",
        message: "Passkey request could not be completed.",
      },
    }),
    {
      status: 400,
      headers: { "content-type": "application/json" },
    },
  );

const auth = {
  handler: async () => new Response(null, { status: 404 }),
  api: {
    async getSession() {
      return new Response("null", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    async deltaPasskeyEnrollmentOptions() {
      calls.enrollmentOptions += 1;
      return safeInternalError();
    },
    async deltaPasskeyEnrollmentVerify() {
      calls.enrollmentVerify += 1;
      return safeInternalError();
    },
    async deltaPasskeyAuthenticationOptions() {
      calls.authenticationOptions += 1;
      return safeInternalError();
    },
    async deltaPasskeyAuthenticationVerify() {
      calls.authenticationVerify += 1;
      return safeInternalError();
    },
  },
};

const moduleCache = new Map();
const moduleMocks = new Map([
  [
    configPath,
    {
      loadAuthEnv() {
        return Object.freeze({
          secret: "s".repeat(32),
          replayPepper: "r".repeat(32),
          recoveryPepper: "c".repeat(32),
          baseUrl: trustedOrigin,
          trustedOrigins: Object.freeze([trustedOrigin]),
          useSecureCookies: true,
          webauthn: Object.freeze({
            rpId: "delta.example",
            rpName: "Delta",
            origin: trustedOrigin,
            userVerification: "required",
            attestation: "none",
            residentKey: "preferred",
            requireResidentKey: false,
            requireUserPresence: true,
          }),
        });
      },
    },
  ],
  [
    publicPluginPath,
    {
      async createProductionPasskeyAdministrationService() {
        calls.administrationFactory += 1;
        const unavailable = async () => {
          calls.administration += 1;
          return Object.freeze({
            kind: "error",
            code: "PASSKEY_UNAVAILABLE",
          });
        };
        return Object.freeze({
          list: unavailable,
          rename: unavailable,
          remove: unavailable,
        });
      },
    },
  ],
]);

const externalMocks = new Map([
  [
    "better-auth/crypto",
    {
      async verifyPassword() {
        throw new Error("password verification is unreachable");
      },
    },
  ],
  [
    "better-auth/node",
    {
      fromNodeHeaders(headers) {
        const output = new Headers();
        for (const [name, value] of Object.entries(headers)) {
          if (typeof value === "string") output.set(name, value);
          if (Array.isArray(value)) {
            for (const item of value) output.append(name, item);
          }
        }
        return output;
      },
      toNodeHandler() {
        return (_request, response) => {
          response.status(404).json({
            error: {
              code: "BETTER_AUTH_ROUTE_DISABLED",
              message: "The internal authentication route is unavailable.",
            },
          });
        };
      },
    },
  ],
]);

function sourcePath(fromPath, specifier) {
  const candidate = resolve(dirname(fromPath), specifier);
  return candidate.endsWith(".js")
    ? candidate.slice(0, -3) + ".ts"
    : candidate;
}

function loadTypeScript(filePath) {
  const normalized = resolve(filePath);
  if (moduleMocks.has(normalized)) return moduleMocks.get(normalized);
  if (moduleCache.has(normalized)) return moduleCache.get(normalized).exports;

  const source = readFileSync(normalized, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: normalized,
  }).outputText;
  const module = { exports: {} };
  moduleCache.set(normalized, module);

  const localRequire = (specifier) => {
    if (externalMocks.has(specifier)) return externalMocks.get(specifier);
    if (specifier.startsWith(".")) {
      return loadTypeScript(sourcePath(normalized, specifier));
    }
    return nativeRequire(specifier);
  };

  const evaluate = new Function(
    "exports",
    "require",
    "module",
    "__filename",
    "__dirname",
    `${output}\n//# sourceURL=${normalized}`,
  );
  evaluate(
    module.exports,
    localRequire,
    module,
    normalized,
    dirname(normalized),
  );
  return module.exports;
}

const { createApp } = loadTypeScript(appPath);
const { ApplicationState } = loadTypeScript(
  resolve("src/runtime/application-state.ts"),
);

const app = createApp(
  new ApplicationState(),
  {
    databaseReady: async () => true,
    authDatabaseReady: async () => true,
  },
  auth,
  {
    database,
    trustedOrigins: [trustedOrigin],
    observeActivity: async () => {
      throw new Error("activity observation is unreachable");
    },
  },
  {
    database,
    trustedOrigins: [trustedOrigin],
    replayPepper: "r".repeat(32),
    totpEncryptionKey: "s".repeat(32),
    observeActivity: async () => {
      throw new Error("activity observation is unreachable");
    },
  },
  {
    database,
    trustedOrigins: [trustedOrigin],
    recoveryPepper: "c".repeat(32),
  },
);

class MemorySocket extends Duplex {
  constructor() {
    super();
    this.parts = [];
  }

  _read() {}

  _write(chunk, _encoding, callback) {
    this.parts.push(Buffer.from(chunk));
    callback();
  }
}

async function dispatch(path, options = {}) {
  const body = options.body;
  const encoded = options.rawBody !== undefined
    ? Buffer.from(options.rawBody)
    : body === undefined
      ? null
      : Buffer.from(JSON.stringify(body));
  const socket = new MemorySocket();
  const request = new IncomingMessage(socket);
  request.method = options.method ?? "GET";
  request.url = path;
  request.headers = {
    host: "delta.example",
    ...(encoded === null
      ? {}
      : {
          ...(options.contentType === null
            ? {}
            : {
                "content-type":
                  options.contentType ?? "application/json",
              }),
          ...(options.chunked
            ? { "transfer-encoding": "chunked" }
            : options.omitContentLength
              ? {}
              : {
                  "content-length": String(
                    options.contentLength ?? encoded.length,
                  ),
                }),
        }),
    ...(options.headers ?? {}),
  };
  const response = new ServerResponse(request);
  const responseParts = [];
  response.write = (chunk) => {
    responseParts.push(Buffer.from(chunk));
    return true;
  };
  response.end = (chunk) => {
    if (chunk !== undefined && chunk !== null) {
      responseParts.push(Buffer.from(chunk));
    }
    response.emit("finish");
    return response;
  };
  const finished = new Promise((resolvePromise, rejectPromise) => {
    response.once("finish", resolvePromise);
    response.once("error", rejectPromise);
  });

  app.handle(request, response);
  if (encoded !== null) request.push(encoded);
  request.push(null);
  await finished;

  const responseBody = Buffer.concat(responseParts).toString("utf8");
  return {
    status: response.statusCode,
    body: responseBody === "" ? undefined : JSON.parse(responseBody),
    headers: response.getHeaders(),
  };
}

function routeInventory(router) {
  return router.stack
    .filter((layer) => layer.route)
    .map((layer) => ({
      path: layer.route.path,
      methods: Object.keys(layer.route.methods)
        .filter((method) => layer.route.methods[method])
        .sort(),
    }));
}

const expectedRoutes = [
  { path: "/registration/options", methods: ["post"] },
  { path: "/registration/verify", methods: ["post"] },
  { path: "/authentication/options", methods: ["post"] },
  { path: "/authentication/verify", methods: ["post"] },
  { path: "/", methods: ["get"] },
  { path: "/:id/rename", methods: ["post"] },
  { path: "/:id/delete", methods: ["post"] },
];

function exactRegistrationVerifyBody(
  byteLength,
  { multibyte = false } = {},
) {
  const prefix = Buffer.from('{"response":{"padding":"');
  const suffix = Buffer.from('"}}');
  const available = byteLength - prefix.length - suffix.length;
  assert.ok(available >= 0);

  let padding;
  if (multibyte) {
    padding = `${"é".repeat(Math.floor(available / 2))}${
      available % 2 === 0 ? "" : "a"
    }`;
  } else {
    padding = "a".repeat(available);
  }

  const output = Buffer.concat([
    prefix,
    Buffer.from(padding),
    suffix,
  ]);
  assert.equal(output.length, byteLength);
  return output;
}

test("app mounts exactly one accepted seven-operation passkey router before 404", () => {
  const candidates = app.router.stack.filter((layer) => {
    if (!Array.isArray(layer.handle?.stack)) return false;
    return expectedRoutes.every((expected) =>
      routeInventory(layer.handle).some(
        (actual) =>
          actual.path === expected.path &&
          actual.methods.join(",") === expected.methods.join(","),
      ),
    );
  });
  assert.equal(candidates.length, 1);
  assert.deepEqual(routeInventory(candidates[0].handle), expectedRoutes);

  const passkeyIndex = app.router.stack.indexOf(candidates[0]);
  const notFoundIndex = app.router.stack.findIndex(
    (layer) => layer.handle?.name === "notFoundMiddleware",
  );
  assert.ok(passkeyIndex >= 0);
  assert.ok(notFoundIndex > passkeyIndex);
  assert.equal(calls.administrationFactory, 1);
});

test("all four ceremony routes are reached through the mounted real router without storage", async () => {
  const cases = [
    ["/api/v1/auth/passkeys/registration/options", { password: "synthetic proof" }],
    ["/api/v1/auth/passkeys/registration/verify", {}],
    ["/api/v1/auth/passkeys/authentication/options", { unexpected: true }],
    ["/api/v1/auth/passkeys/authentication/verify", {}],
  ];

  for (const [path, body] of cases) {
    const response = await dispatch(path, {
      method: "POST",
      headers: { origin: trustedOrigin },
      body,
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "PASSKEY_REQUEST_REJECTED");
    assert.notEqual(response.body.error.code, "ROUTE_NOT_FOUND");
  }

  assert.deepEqual(
    [
      calls.enrollmentOptions,
      calls.enrollmentVerify,
      calls.authenticationOptions,
      calls.authenticationVerify,
    ],
    [1, 0, 0, 0],
  );
  assert.equal(calls.database, 0);
});

test("management routes are reachable and stop at session or origin gates before storage", async () => {
  const list = await dispatch("/api/v1/auth/passkeys");
  assert.equal(list.status, 401);
  assert.equal(list.body.error.code, "PASSKEY_REQUEST_REJECTED");

  for (const operation of ["rename", "delete"]) {
    const response = await dispatch(
      `/api/v1/auth/passkeys/synthetic-target/${operation}`,
      {
        method: "POST",
        headers: { origin: trustedOrigin },
        body: operation === "rename"
          ? { name: "Synthetic key" }
          : { password: "synthetic proof" },
      },
    );
    assert.equal(response.status, 401);
    assert.equal(response.body.error.code, "PASSKEY_REQUEST_REJECTED");
  }

  assert.equal(calls.administration, 0);
  assert.equal(calls.database, 0);
});

test("raw Delta and Better Auth passkey HTTP endpoints remain contained", async () => {
  const deltaPaths = [
    "/delta-passkey/enrollment/options",
    "/delta-passkey/enrollment/verify",
    "/delta-passkey/authentication/options",
    "/delta-passkey/authentication/verify",
  ];
  const betterAuthPaths = [
    "/passkey/generate-register-options",
    "/passkey/generate-authenticate-options",
    "/passkey/verify-registration",
    "/passkey/verify-authentication",
    "/passkey/list-user-passkeys",
    "/passkey/delete-passkey",
    "/passkey/update-passkey",
  ];
  for (const rawPath of [...deltaPaths, ...betterAuthPaths]) {
    assert.match(
      coreSource,
      new RegExp(`['\"]${rawPath.replaceAll("/", "\\/")}['\"]`),
    );
    const response = await dispatch(`/api/auth${rawPath}`, {
      method: "POST",
      body: {},
    });
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, "BETTER_AUTH_ROUTE_DISABLED");
  }
  assert.doesNotMatch(coreSource, /delta-passkey\/management/);
  assert.equal(calls.database, 0);
});

test("health contract and canonical application 404 survive passkey composition", async () => {
  const health = await dispatch("/api/v1/health");
  assert.equal(health.status, 200);
  assert.equal(health.body.status, "ok");
  assert.equal(health.body.service, "delta-backend");
  assert.equal(health.body.version, "v1");
  assert.equal(typeof health.body.timestamp, "string");

  const missing = await dispatch("/api/v1/synthetic-unknown");
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, "ROUTE_NOT_FOUND");
  assert.equal(
    missing.body.error.message,
    "The requested API route does not exist.",
  );
});

test("malformed passkey failures keep the sanitized public error contract", async () => {
  const response = await dispatch(
    "/api/v1/auth/passkeys/authentication/verify",
    { method: "POST", body: { unexpected: true } },
  );
  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, "PASSKEY_REQUEST_REJECTED");
  assert.equal(
    response.body.error.message,
    "Passkey request could not be completed.",
  );
  assert.equal(typeof response.body.error.requestId, "string");
  assert.doesNotMatch(
    JSON.stringify(response.body),
    /stack|select |insert |better-auth|simplewebauthn|\/home\//i,
  );
});

test("passkey parser enforces the exact 65536-byte boundary before route operations", async () => {
  for (const size of [65535, 65536]) {
    const before = calls.enrollmentVerify;
    const response = await dispatch(
      "/api/v1/auth/passkeys/registration/verify",
      {
        method: "POST",
        rawBody: exactRegistrationVerifyBody(size),
      },
    );
    assert.notEqual(response.status, 413);
    assert.equal(calls.enrollmentVerify, before + 1);
  }

  for (const size of [65537, 102400, 102401]) {
    const before = calls.enrollmentVerify;
    const response = await dispatch(
      "/api/v1/auth/passkeys/registration/verify",
      {
        method: "POST",
        rawBody: exactRegistrationVerifyBody(size),
      },
    );
    assert.equal(response.status, 413);
    assert.equal(response.body.error.code, "PASSKEY_REQUEST_REJECTED");
    assert.equal(
      response.body.error.message,
      "Passkey request could not be completed.",
    );
    assert.equal(calls.enrollmentVerify, before);
  }
});

test("passkey parser measures UTF-8 bytes and enforces the limit for chunked transfer", async () => {
  const acceptedBefore = calls.enrollmentVerify;
  const accepted = await dispatch(
    "/api/v1/auth/passkeys/registration/verify",
    {
      method: "POST",
      rawBody: exactRegistrationVerifyBody(65536, {
        multibyte: true,
      }),
      chunked: true,
      contentType: "application/json; charset=utf-8",
    },
  );
  assert.notEqual(accepted.status, 413);
  assert.equal(calls.enrollmentVerify, acceptedBefore + 1);

  const rejectedBefore = calls.enrollmentVerify;
  const rejected = await dispatch(
    "/api/v1/auth/passkeys/registration/verify",
    {
      method: "POST",
      rawBody: exactRegistrationVerifyBody(65537, {
        multibyte: true,
      }),
      chunked: true,
      contentType: "application/json; charset=utf-8",
    },
  );
  assert.equal(rejected.status, 413);
  assert.equal(calls.enrollmentVerify, rejectedBefore);

  const misleadingBefore = calls.enrollmentVerify;
  const misleading = await dispatch(
    "/api/v1/auth/passkeys/registration/verify",
    {
      method: "POST",
      rawBody: exactRegistrationVerifyBody(65537),
      contentLength: 1,
    },
  );
  assert.ok(misleading.status >= 400);
  assert.equal(
    misleading.body.error.message,
    "Passkey request could not be completed.",
  );
  assert.equal(calls.enrollmentVerify, misleadingBefore);

  const compressedBefore = calls.enrollmentVerify;
  const compressed = await dispatch(
    "/api/v1/auth/passkeys/registration/verify",
    {
      method: "POST",
      rawBody: gzipSync(
        exactRegistrationVerifyBody(65537),
      ),
      headers: { "content-encoding": "gzip" },
    },
  );
  assert.equal(compressed.status, 413);
  assert.equal(calls.enrollmentVerify, compressedBefore);
});

test("malformed and oversized passkey JSON use the safe envelope, cache, and request ID", async () => {
  for (const testCase of [
    {
      rawBody: Buffer.from('{"response":'),
      expectedStatus: 400,
      requestId: "passkey-malformed-json",
    },
    {
      rawBody: exactRegistrationVerifyBody(65537),
      expectedStatus: 413,
      requestId: "passkey-oversized-json",
    },
  ]) {
    const before = calls.enrollmentVerify;
    const response = await dispatch(
      "/api/v1/auth/passkeys/registration/verify",
      {
        method: "POST",
        rawBody: testCase.rawBody,
        headers: { "x-request-id": testCase.requestId },
      },
    );
    assert.equal(response.status, testCase.expectedStatus);
    assert.deepEqual(response.body, {
      error: {
        code: "PASSKEY_REQUEST_REJECTED",
        message: "Passkey request could not be completed.",
        requestId: testCase.requestId,
      },
    });
    assert.equal(response.headers["x-request-id"], testCase.requestId);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(response.headers.pragma, "no-cache");
    assert.equal(response.headers["set-cookie"], undefined);
    assert.equal(calls.enrollmentVerify, before);
  }
});

test("all six public passkey POST routes share the scoped body gate while GET behavior is preserved", async () => {
  const postPaths = [
    "/api/v1/auth/passkeys/registration/options",
    "/api/v1/auth/passkeys/registration/verify",
    "/api/v1/auth/passkeys/authentication/options",
    "/api/v1/auth/passkeys/authentication/verify",
    "/api/v1/auth/passkeys/synthetic-target/rename",
    "/api/v1/auth/passkeys/synthetic-target/delete",
  ];
  for (const path of postPaths) {
    const response = await dispatch(path, {
      method: "POST",
      rawBody: exactRegistrationVerifyBody(65537),
    });
    assert.equal(response.status, 413);
    assert.equal(response.body.error.code, "PASSKEY_REQUEST_REJECTED");
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(response.headers.pragma, "no-cache");
  }

  const list = await dispatch("/api/v1/auth/passkeys");
  assert.equal(list.status, 401);
  assert.equal(list.body.error.code, "PASSKEY_REQUEST_REJECTED");

  const unsupported = await dispatch(
    "/api/v1/auth/passkeys/registration/options",
  );
  assert.equal(unsupported.status, 404);
  assert.equal(unsupported.body.error.code, "PASSKEY_NOT_FOUND");
});

test("non-passkey routes retain the default global parser behavior", async () => {
  for (const size of [65537, 102400]) {
    const response = await dispatch(
      "/api/v1/synthetic-unknown",
      {
        method: "POST",
        rawBody: exactRegistrationVerifyBody(size),
      },
    );
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, "ROUTE_NOT_FOUND");
  }

  const oversized = await dispatch(
    "/api/v1/synthetic-unknown",
    {
      method: "POST",
      rawBody: exactRegistrationVerifyBody(102401),
    },
  );
  assert.equal(oversized.status, 500);
  assert.equal(oversized.body.error.code, "INTERNAL_SERVER_ERROR");

  const malformed = await dispatch(
    "/api/v1/synthetic-unknown",
    {
      method: "POST",
      rawBody: Buffer.from('{"response":'),
    },
  );
  assert.equal(malformed.status, 400);
  assert.equal(malformed.body.error.code, "INVALID_JSON");
});

test("app scopes the 64kb parser before the unchanged normal-route parser and unrelated mounts", () => {
  assert.match(appSource, /app\.use\(\s*PASSKEY_PUBLIC_PREFIX,/);
  assert.equal(
    (appSource.match(/createPasskeyRouter\s*\(/g) ?? []).length,
    1,
  );
  assert.equal(
    (appSource.match(/limit:\s*PASSKEY_JSON_BODY_LIMIT/g) ?? []).length,
    1,
  );
  assert.ok(
    appSource.indexOf("limit: PASSKEY_JSON_BODY_LIMIT") <
      appSource.indexOf("normalDeltaJsonParser"),
  );
  assert.match(
    appSource,
    /normalDeltaJsonParser\s*=\s*express\.json\(\)/,
  );
  assert.match(
    appSource,
    /passkeyJsonParsed\s*===\s*true/,
  );
  for (const marker of [
    '"/api/v1/auth/sessions"',
    '"/api/v1/auth/mfa/totp"',
    '"/api/v1/health"',
    "createRecoveryRouter",
    "notFoundMiddleware",
    "errorHandlerMiddleware",
  ]) {
    assert.ok(appSource.includes(marker));
  }
});
