import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const pluginSource = readFileSync("src/auth/passkey-public-plugin.ts", "utf8");
const securityPluginSource = readFileSync("src/auth/passkey-plugin.ts", "utf8");
const coreSource = readFileSync("src/auth/core.ts", "utf8");
const appSource = readFileSync("src/app.ts", "utf8");
const managementProofSource = readFileSync("src/auth/passkey-management-proof.ts", "utf8");

function loadCommonJs(source, fileName, imports) {
  const module = { exports: {} };
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName,
  }).outputText;
  vm.runInNewContext(output, {
    exports: module.exports,
    module,
    require(specifier) {
      if (specifier in imports) return imports[specifier];
      throw new Error(`Unexpected management test import: ${specifier}`);
    },
    Buffer,
    Date,
    Error,
    Headers,
    JSON,
    Map,
    Number,
    Object,
    Promise,
    Set,
    URL,
  });
  return module.exports;
}

const proofModule = loadCommonJs(
  managementProofSource,
  "passkey-management-proof.ts",
  {
    "./password-policy.js": {
      AUTH_PASSWORD_MIN_LENGTH: 12,
      AUTH_PASSWORD_MAX_LENGTH: 128,
    },
    "./totp-replay.js": {
      createTotpReplayDigest() { return "a".repeat(64); },
    },
    "./totp-replacement.js": {
      isValidTotpCode(value) { return /^[0-9]{6}$/.test(value); },
      async verifyEncryptedTotpCode() { throw new Error("unused verifier"); },
    },
  },
);

class FakeCeremonyError extends Error {
  constructor(code) { super("synthetic"); this.code = code; }
}

const pluginModule = loadCommonJs(
  pluginSource,
  "passkey-public-plugin.ts",
  {
    "@better-auth/core/context": {
      async getCurrentAdapter(adapter) { return adapter; },
      async runWithTransaction(_adapter, fn) { return fn(); },
    },
    "better-auth/api": {
      createAuthEndpoint(path, options, handler) {
        handler.path = path;
        handler.options = options;
        return handler;
      },
      async getSessionFromCtx() { return null; },
    },
    "./passkey-ceremony.js": {
      PasskeyCeremonyError: FakeCeremonyError,
      passkeyCeremonyServices: {
        async registrationOptions() { return {}; },
        async verifyRegistration() { throw new Error("unused"); },
      },
    },
    "./passkey-challenge.js": { clearPasskeyLookupCookie() {} },
    "./passkey-management-proof.js": proofModule,
    "./mfa-security-audit.js": { tryLogPasskeySecurityAuditEvent() {} },
    "../storage/passkey-rate-limit.js": {
      createPasskeyDurableRateLimiter() { return async () => true; },
    },
  },
);

const securityPluginModule = loadCommonJs(
  securityPluginSource,
  "passkey-plugin.ts",
  {
    "@better-auth/core/context": {
      async getCurrentAdapter(adapter) { return adapter; },
      async runWithTransaction(_adapter, fn) { return fn(); },
    },
    "better-auth/cookies": {
      async setSessionCookie() {},
    },
    "./passkey-ceremony.js": {
      PasskeyCeremonyError: FakeCeremonyError,
      passkeyCeremonyServices: {
        async verifyAuthentication() { throw new Error("unused verifier"); },
      },
    },
    "./passkey-challenge.js": { clearPasskeyLookupCookie() {} },
    "./passkey-counter.js": {
      passkeyCounterFromDatabase(value) { return Number(value); },
      passkeyCounterToDatabase(value) { return String(value); },
    },
    "../storage/passkey-session-marker.js": {
      async insertPasskeySessionMarker() {},
    },
  },
);

const session = Object.freeze({
  sessionId: "synthetic-session",
  userId: "synthetic-authoritative-user",
});
const safeView = Object.freeze({
  id: "synthetic-passkey",
  name: "Synthetic key",
  createdAt: new Date("2026-09-11T12:00:00.000Z"),
  deviceType: "multiDevice",
  backedUp: true,
});

function proofDependencies(events, options = {}) {
  const now = new Date("2026-09-11T12:00:00.000Z");
  return {
    async loadSecurityState() {
      events.push("SECURITY_STATE");
      return {
        sessionValid: true,
        passwordHash: "synthetic-password-hash",
        totp: options.totp === false
          ? { state: "absent" }
          : { state: "active", encryptedSecret: "synthetic-encrypted", lockedUntil: null },
      };
    },
    async verifyPassword() {
      events.push("PASSWORD_PROOF");
      return options.password !== false;
    },
    async claimTotpReplay() {
      events.push("TOTP_REPLAY_CLAIM");
      return options.replay !== false;
    },
    encryptionKey: "synthetic-encryption-key-material",
    replayPepper: "synthetic-replay-key-material-0123456789",
    now: () => new Date(now),
    async verifyTotp() {
      events.push("TOTP_PROOF");
      return options.code !== false;
    },
  };
}

function harness(options = {}) {
  const events = [];
  const audits = [];
  let storageCalls = 0;
  const dependencies = {
    async executeSecurity(input) {
      for (const identity of input.identities) {
        events.push(`LIMIT:${input.operation}:${identity.kind}:${identity.source}`);
        if (options.limit === input.operation) {
          return { status: "rate_limited", error: { code: "PASSKEY_RATE_LIMITED" } };
        }
        if (options.limitFailure === input.operation) {
          return { status: "unavailable", error: { code: "PASSKEY_UNAVAILABLE" } };
        }
      }
      let value;
      try {
        value = await input.run();
      } catch {
        return { status: "unavailable", error: { code: "PASSKEY_UNAVAILABLE" } };
      }
      if (value === null) {
        return {
          status: "rejected",
          error: {
            code: input.operation === "managementFreshProof"
              ? "PASSKEY_FRESH_PROOF_REJECTED"
              : "PASSKEY_REQUEST_REJECTED",
          },
        };
      }
      const classification = input.classify?.(value);
      if (classification && classification.status !== "success") {
        return { status: classification.status, error: { code: classification.code } };
      }
      audits.push({ operation: input.operation, metadata: {} });
      return { status: "success", value };
    },
    async listOwned(_database, userId) {
      storageCalls += 1;
      events.push(`STORAGE_LIST:${userId}`);
      return options.listResult ?? { status: "listed", passkeys: [safeView] };
    },
    async renameOwned(_database, input) {
      storageCalls += 1;
      events.push(`STORAGE_RENAME:${input.userId}`);
      return options.renameResult ?? { status: "renamed", passkey: { ...safeView, name: input.name } };
    },
    async removeOwned(_database, input) {
      storageCalls += 1;
      events.push(`STORAGE_DELETE:${input.userId}`);
      return options.deleteResult ?? { status: "deleted" };
    },
    createTrustedContext: proofModule.createTrustedPasskeyManagementContext,
    verifyFreshProof: proofModule.verifyPasskeyManagementFreshProof,
  };
  const service = pluginModule.createPasskeyAdministrationService(
    {},
    ["https://example.test"],
    proofDependencies(events, options),
    dependencies,
  );
  return {
    audits,
    events,
    service,
    get storageCalls() { return storageCalls; },
    deleteInput: {
      session,
      requestId: "synthetic-request",
      networkSource: "synthetic-network",
      requestOrigin: "https://example.test",
      id: "synthetic-passkey",
      proof: { password: "synthetic-current-password", totpCode: "123456" },
    },
  };
}

function realSecurityHarness(options = {}) {
  const events = [];
  const audits = [];
  let storageCalls = 0;
  const perimeter = securityPluginModule.createPasskeySecurityPerimeter({
    async takeDurableLimit(input) {
      events.push(`LIMIT:${input.operation}:${input.identity.kind}:${input.identity.source}`);
      if (options.limitFailure === input.operation) {
        throw new Error("synthetic-limiter-persistence-detail");
      }
      return options.limit !== input.operation;
    },
    emitAudit(event) {
      audits.push(event);
      if (options.auditFailure) {
        throw new Error("synthetic-audit-delivery-detail");
      }
    },
  });
  const service = pluginModule.createPasskeyAdministrationService(
    {},
    ["https://example.test"],
    proofDependencies(events, options),
    {
      executeSecurity: perimeter.execute,
      async listOwned(_database, userId) {
        storageCalls += 1;
        events.push(`STORAGE_LIST:${userId}`);
        return options.listResult ?? { status: "listed", passkeys: [safeView] };
      },
      async renameOwned(_database, input) {
        storageCalls += 1;
        events.push(`STORAGE_RENAME:${input.userId}`);
        return options.renameResult ?? {
          status: "renamed",
          passkey: { ...safeView, name: input.name },
        };
      },
      async removeOwned(_database, input) {
        storageCalls += 1;
        events.push(`STORAGE_DELETE:${input.userId}`);
        return options.deleteResult ?? { status: "deleted" };
      },
      createTrustedContext: proofModule.createTrustedPasskeyManagementContext,
      verifyFreshProof: proofModule.verifyPasskeyManagementFreshProof,
    },
  );
  return {
    audits,
    events,
    service,
    get storageCalls() { return storageCalls; },
    deleteInput: {
      session,
      requestId: "synthetic-request",
      networkSource: "synthetic-network",
      requestOrigin: "https://example.test",
      id: "synthetic-passkey",
      proof: { password: "synthetic-current-password", totpCode: "123456" },
    },
  };
}

test("management is composed as a service and adds no raw Better Auth endpoint", () => {
  assert.equal(typeof pluginModule.createPasskeyAdministrationService, "function");
  assert.doesNotMatch(pluginSource, /delta-passkey\/management/);
  assert.doesNotMatch(coreSource, /delta-passkey\/management/);
});

test("list uses authoritative user limiter before I4 storage and returns its safe view", async () => {
  const state = harness();
  const result = await state.service.list({ session, requestId: "synthetic-request" });
  assert.equal(result.kind, "success");
  assert.deepEqual(state.events, [
    "LIMIT:managementList:user:synthetic-authoritative-user",
    "STORAGE_LIST:synthetic-authoritative-user",
  ]);
  assert.equal(result.value[0].id, safeView.id);
});

test("list rate rejection and limiter storage failure fail closed before storage", async () => {
  for (const key of ["limit", "limitFailure"]) {
    const state = harness({ [key]: "managementList" });
    const result = await state.service.list({ session, requestId: "synthetic-request" });
    assert.equal(result.kind, "error");
    assert.equal(result.code, key === "limit" ? "PASSKEY_RATE_LIMITED" : "PASSKEY_UNAVAILABLE");
    assert.equal(state.storageCalls, 0);
  }
});

test("rename is user scoped and maps missing and wrong owner identically", async () => {
  for (const marker of ["missing", "foreign-owner"]) {
    const state = harness({ renameResult: { status: "not_found", marker } });
    const result = await state.service.rename({
      session,
      requestId: "synthetic-request",
      id: "synthetic-target",
      name: "Renamed key",
    });
    assert.deepEqual(JSON.parse(JSON.stringify(result)), {
      kind: "error",
      code: "PASSKEY_NOT_FOUND",
    });
    assert.equal(JSON.stringify(result).includes(marker), false);
    assert.deepEqual(state.events, [
      "LIMIT:managementRename:user:synthetic-authoritative-user",
      "STORAGE_RENAME:synthetic-authoritative-user",
    ]);
  }
});

test("managementRename limiter rejection prevents rename storage", async () => {
  const state = realSecurityHarness({ limit: "managementRename" });
  const result = await state.service.rename({
    session,
    requestId: "synthetic-request",
    id: "synthetic-target",
    name: "Renamed key",
  });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    kind: "error",
    code: "PASSKEY_RATE_LIMITED",
  });
  assert.equal(state.storageCalls, 0);
  assert.deepEqual(state.events, [
    "LIMIT:managementRename:user:synthetic-authoritative-user",
  ]);
  const serialized = JSON.stringify(result);
  for (const forbidden of ["synthetic-target", "lookupCookie", "sessionToken", "setCookie"]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test("managementRename limiter persistence failure fails closed before rename storage", async () => {
  const state = realSecurityHarness({ limitFailure: "managementRename" });
  const result = await state.service.rename({
    session,
    requestId: "synthetic-request",
    id: "synthetic-target",
    name: "Renamed key",
  });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    kind: "error",
    code: "PASSKEY_UNAVAILABLE",
  });
  assert.equal(state.storageCalls, 0);
  assert.deepEqual(state.events, [
    "LIMIT:managementRename:user:synthetic-authoritative-user",
  ]);
  assert.equal(JSON.stringify(result).includes("synthetic-limiter-persistence-detail"), false);
});

test("delete enforces fresh proof then destructive limiter then I4 guard", async () => {
  const state = harness();
  const result = await state.service.remove(state.deleteInput);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { kind: "success" });
  assert.deepEqual(state.events, [
    "LIMIT:managementFreshProof:network:synthetic-network",
    "LIMIT:managementFreshProof:user:synthetic-authoritative-user",
    "SECURITY_STATE",
    "PASSWORD_PROOF",
    "TOTP_PROOF",
    "TOTP_REPLAY_CLAIM",
    "LIMIT:managementDelete:user:synthetic-authoritative-user",
    "STORAGE_DELETE:synthetic-authoritative-user",
  ]);
});

test("managementDelete limiter rejection after fresh proof prevents I4 delete", async () => {
  const state = realSecurityHarness({ limit: "managementDelete" });
  const result = await state.service.remove(state.deleteInput);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    kind: "error",
    code: "PASSKEY_RATE_LIMITED",
  });
  assert.equal(state.storageCalls, 0);
  assert.deepEqual(state.events, [
    "LIMIT:managementFreshProof:network:synthetic-network",
    "LIMIT:managementFreshProof:user:synthetic-authoritative-user",
    "SECURITY_STATE",
    "PASSWORD_PROOF",
    "TOTP_PROOF",
    "TOTP_REPLAY_CLAIM",
    "LIMIT:managementDelete:user:synthetic-authoritative-user",
  ]);
  const serialized = JSON.stringify(result);
  for (const forbidden of ["lookupCookie", "sessionToken", "setCookie"]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test("managementDelete limiter persistence failure fails closed before I4 delete", async () => {
  const state = realSecurityHarness({ limitFailure: "managementDelete" });
  const result = await state.service.remove(state.deleteInput);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    kind: "error",
    code: "PASSKEY_UNAVAILABLE",
  });
  assert.equal(state.storageCalls, 0);
  assert.deepEqual(state.events, [
    "LIMIT:managementFreshProof:network:synthetic-network",
    "LIMIT:managementFreshProof:user:synthetic-authoritative-user",
    "SECURITY_STATE",
    "PASSWORD_PROOF",
    "TOTP_PROOF",
    "TOTP_REPLAY_CLAIM",
    "LIMIT:managementDelete:user:synthetic-authoritative-user",
  ]);
  assert.equal(JSON.stringify(result).includes("synthetic-limiter-persistence-detail"), false);
});

test("delete accepts password alone only when TOTP is not active", async () => {
  const state = harness({ totp: false });
  const result = await state.service.remove({
    ...state.deleteInput,
    proof: { password: "synthetic-current-password" },
  });
  assert.equal(result.kind, "success");
  assert.equal(state.events.includes("TOTP_PROOF"), false);
  assert.equal(state.events.includes("TOTP_REPLAY_CLAIM"), false);
});

test("wrong password missing TOTP wrong TOTP and replay reject before delete", async () => {
  const scenarios = [
    [{ password: false }, { password: "synthetic-current-password", totpCode: "123456" }],
    [{}, { password: "synthetic-current-password" }],
    [{ code: false }, { password: "synthetic-current-password", totpCode: "123456" }],
    [{ replay: false }, { password: "synthetic-current-password", totpCode: "123456" }],
  ];
  for (const [options, proof] of scenarios) {
    const state = harness(options);
    const result = await state.service.remove({ ...state.deleteInput, proof });
    assert.equal(result.kind, "error");
    assert.equal(result.code, "PASSKEY_FRESH_PROOF_REJECTED");
    assert.equal(state.storageCalls, 0);
    assert.equal(state.events.some((entry) => entry.startsWith("LIMIT:managementDelete")), false);
  }
});

test("fresh-proof replay remains consumed when later delete storage is unavailable", async () => {
  const state = harness({ deleteResult: { status: "unavailable" } });
  const result = await state.service.remove(state.deleteInput);
  assert.equal(result.code, "PASSKEY_UNAVAILABLE");
  assert.equal(state.events.filter((entry) => entry === "TOTP_REPLAY_CLAIM").length, 1);
});

test("last usable login guard maps to the finite safe conflict", async () => {
  const state = harness({ deleteResult: { status: "last_login_method_required", remaining: 0 } });
  const result = await state.service.remove(state.deleteInput);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    kind: "error",
    code: "PASSKEY_LAST_LOGIN_METHOD_REQUIRED",
  });
  assert.equal(JSON.stringify(result).includes("remaining"), false);
});

test("delete not-found is enumeration safe", async () => {
  for (const marker of ["missing", "wrong-owner"]) {
    const state = harness({ deleteResult: { status: "not_found", marker } });
    const result = await state.service.remove(state.deleteInput);
    assert.equal(result.code, "PASSKEY_NOT_FOUND");
    assert.equal(JSON.stringify(result).includes(marker), false);
  }
});

test("management service emits no cookie or session-shaped output", async () => {
  const state = harness();
  const results = [
    await state.service.list({ session, requestId: "synthetic-request" }),
    await state.service.rename({ session, requestId: "synthetic-request", id: "target", name: "Name" }),
    await state.service.remove(state.deleteInput),
  ];
  const serialized = JSON.stringify(results);
  for (const forbidden of ["setCookie", "sessionToken", "lookupCookie", "credentialID", "publicKey"]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test("management audit input stays metadata-free and uses finite operation classes", async () => {
  const state = harness();
  await state.service.list({ session, requestId: "synthetic-request" });
  await state.service.rename({ session, requestId: "synthetic-request", id: "target", name: "Secret name" });
  await state.service.remove(state.deleteInput);
  assert.deepEqual(state.audits.map(({ operation }) => operation), [
    "managementList",
    "managementRename",
    "managementFreshProof",
    "managementDelete",
  ]);
  assert.equal(JSON.stringify(state.audits).includes("Secret name"), false);
  assert.equal(JSON.stringify(state.audits).includes("synthetic-passkey"), false);
});

test("management audit delivery failure cannot change authoritative success or rejection", async () => {
  const successful = realSecurityHarness({ auditFailure: true });
  const successResult = await successful.service.list({
    session,
    requestId: "synthetic-request",
  });
  assert.equal(successResult.kind, "success");
  assert.equal(successful.storageCalls, 1);

  const rejected = realSecurityHarness({
    auditFailure: true,
    renameResult: { status: "not_found" },
  });
  const rejectedResult = await rejected.service.rename({
    session,
    requestId: "synthetic-request",
    id: "synthetic-target",
    name: "Renamed key",
  });
  assert.deepEqual(JSON.parse(JSON.stringify(rejectedResult)), {
    kind: "error",
    code: "PASSKEY_NOT_FOUND",
  });
  assert.equal(rejected.storageCalls, 1);
  assert.equal(
    JSON.stringify([successResult, rejectedResult]).includes("synthetic-audit-delivery-detail"),
    false,
  );
});

test("I6 mounts the accepted router without moving management policy into app", () => {
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
  assert.doesNotMatch(
    appSource,
    /managementList|managementRename|managementDelete|deleteOwnedPasskeyWithLastLoginGuard|verifyPasskeyManagementFreshProof/,
  );
  assert.doesNotMatch(coreSource, /delta-passkey\/management/);
  assert.doesNotMatch(pluginSource, /assuranceLevel|trustedDevice|stepUpSatisfied/);
});
