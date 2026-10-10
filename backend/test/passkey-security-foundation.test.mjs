import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const configSource = readFileSync("src/auth/config.ts", "utf8");
const envExample = readFileSync("../.env.example", "utf8");

const exportsObject = {};
const compiled = ts.transpileModule(configSource, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: "config.ts",
}).outputText;
vm.runInNewContext(compiled, {
  exports: exportsObject,
  module: { exports: exportsObject },
  require(specifier) {
    if (specifier === "./recovery-codes.js") {
      return { requireRecoveryPepper: () => "not-used-by-webauthn-parser" };
    }
    throw new Error(`Unexpected test import: ${specifier}`);
  },
  process: { env: {} },
  URL,
});

const { parseWebAuthnConfig } = exportsObject;

const development = (overrides = {}, trustedOrigins) => {
  const source = {
    NODE_ENV: "development",
    WEBAUTHN_RP_ID: "localhost",
    WEBAUTHN_RP_NAME: "Delta",
    WEBAUTHN_ORIGIN: "http://localhost:8080",
    ...overrides,
  };
  return parseWebAuthnConfig(
    source,
    trustedOrigins ?? [source.WEBAUTHN_ORIGIN],
  );
};

const production = (overrides = {}, trustedOrigins) => {
  const source = {
    NODE_ENV: "production",
    WEBAUTHN_RP_ID: "example.com",
    WEBAUTHN_RP_NAME: "Delta",
    WEBAUTHN_ORIGIN: "https://example.com",
    ...overrides,
  };
  return parseWebAuthnConfig(
    source,
    trustedOrigins ?? [source.WEBAUTHN_ORIGIN],
  );
};

test("WebAuthn requires exactly the three explicit environment inputs", () => {
  for (const name of [
    "WEBAUTHN_RP_ID",
    "WEBAUTHN_RP_NAME",
    "WEBAUTHN_ORIGIN",
  ]) {
    assert.match(configSource, new RegExp(`source\\.${name}`));
    const source = {
      NODE_ENV: "development",
      WEBAUTHN_RP_ID: "localhost",
      WEBAUTHN_RP_NAME: "Delta",
      WEBAUTHN_ORIGIN: "http://localhost:8080",
    };
    delete source[name];
    assert.throws(() => parseWebAuthnConfig(source, ["http://localhost:8080"]));
  }
  assert.doesNotMatch(configSource, /request\.headers|headers\.host|trustedOrigins\[0\]/);
});

test("valid localhost development configuration is immutable", () => {
  const config = development();
  assert.equal(config.rpId, "localhost");
  assert.equal(config.rpName, "Delta");
  assert.equal(config.origin, "http://localhost:8080");
  assert.equal(Object.isFrozen(config), true);
});

test("RP ID rejects schemes, ports, URL components, wildcards and ambiguity", () => {
  for (const rpId of [
    "",
    " ",
    " localhost",
    "localhost ",
    "https://example.com",
    "http://example.com",
    "example.com:443",
    "example.com/path",
    "example.com?x=1",
    "example.com#x",
    "*.example.com",
    "*",
    "user@example.com",
    "Example.com",
    "127.0.0.1",
  ]) {
    assert.throws(() => development({ WEBAUTHN_RP_ID: rpId }));
  }
});

test("RP name is nonempty, exact, bounded and control-free", () => {
  for (const rpName of [
    "",
    " ",
    " Delta",
    "Delta ",
    "Delta\n",
    "x".repeat(65),
  ]) {
    assert.throws(() => development({ WEBAUTHN_RP_NAME: rpName }));
  }
  assert.equal(development({ WEBAUTHN_RP_NAME: "x".repeat(64) }).rpName.length, 64);
});

test("origin rejects non-origins, wildcards, credentials and URL components", () => {
  for (const origin of [
    "",
    " ",
    "*",
    "https://*.example.com",
    "example.com",
    "//example.com",
    "https://user:pass@example.com",
    "https://example.com/path",
    "https://example.com?x=1",
    "https://example.com#x",
    "https://example.com/",
  ]) {
    assert.throws(() =>
      production({ WEBAUTHN_ORIGIN: origin }, [origin]),
    );
  }
});

test("production requires HTTPS and forbids localhost", () => {
  assert.throws(() =>
    parseWebAuthnConfig(
      {
        NODE_ENV: "production",
        WEBAUTHN_RP_ID: "localhost",
        WEBAUTHN_RP_NAME: "Delta",
        WEBAUTHN_ORIGIN: "http://localhost:8080",
      },
      ["http://localhost:8080"],
    ),
  );
  assert.throws(() =>
    production(
      { WEBAUTHN_ORIGIN: "http://example.com" },
      ["http://example.com"],
    ),
  );
  assert.equal(production().origin, "https://example.com");
});

test("RP ID accepts exact and dot-boundary subdomain origins only", () => {
  assert.equal(production().origin, "https://example.com");
  assert.equal(
    production(
      { WEBAUTHN_ORIGIN: "https://auth.example.com" },
      ["https://auth.example.com"],
    ).origin,
    "https://auth.example.com",
  );
  for (const origin of [
    "https://evilexample.com",
    "https://example.net",
  ]) {
    assert.throws(() => production({ WEBAUTHN_ORIGIN: origin }, [origin]));
  }
});

test("WebAuthn origin must be in the explicit trusted-origin set", () => {
  assert.throws(
    () => development({}, ["http://localhost:3001"]),
    /must be present in BETTER_AUTH_TRUSTED_ORIGINS/,
  );
  assert.equal(
    development({}, ["http://localhost:3001", "http://localhost:8080"]).origin,
    "http://localhost:8080",
  );
});

test("security policy is fixed and cannot be downgraded by environment", () => {
  const config = development({
    WEBAUTHN_USER_VERIFICATION: "discouraged",
    WEBAUTHN_ATTESTATION: "direct",
    WEBAUTHN_RESIDENT_KEY: "discouraged",
    WEBAUTHN_REQUIRE_RESIDENT_KEY: "true",
    WEBAUTHN_REQUIRE_USER_PRESENCE: "false",
  });
  assert.equal(config.userVerification, "required");
  assert.equal(config.attestation, "none");
  assert.equal(config.residentKey, "preferred");
  assert.equal(config.requireResidentKey, false);
  assert.equal(config.requireUserPresence, true);
  assert.doesNotMatch(configSource, /advancedFIDOConfig/);
});

test("I3 adds no ceremonies, plugin registration, passwordless or conditional UI", () => {
  assert.doesNotMatch(
    configSource,
    /generateRegistrationOptions|verifyRegistrationResponse|generateAuthenticationOptions|verifyAuthenticationResponse/,
  );
  assert.doesNotMatch(configSource, /@better-auth\/passkey|passkeyClient/);
  assert.doesNotMatch(configSource, /passwordless|conditionalUI|conditionalUi/);
});

test("environment example contains only safe localhost WebAuthn examples", () => {
  assert.match(envExample, /^WEBAUTHN_RP_ID=localhost$/m);
  assert.match(envExample, /^WEBAUTHN_RP_NAME=Delta$/m);
  assert.match(envExample, /^WEBAUTHN_ORIGIN=http:\/\/localhost:8080$/m);
  assert.doesNotMatch(envExample, /^WEBAUTHN_.*(?:example\.com|https:\/\/)/m);
  assert.equal((envExample.match(/^WEBAUTHN_/gm) ?? []).length, 3);
});

const coreSource = readFileSync("src/auth/core.ts", "utf8");
const publicPluginSource = readFileSync(
  "src/auth/passkey-public-plugin.ts",
  "utf8",
);
const challengeSource = readFileSync("src/auth/passkey-challenge.ts", "utf8");
const installedPasskeySource = readFileSync(
  "node_modules/@better-auth/passkey/dist/index.mjs",
  "utf8",
);

const challengeCompiled = ts.transpileModule(challengeSource, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: "passkey-challenge.ts",
}).outputText;
const challengeModule = await import(
  `data:text/javascript;base64,${Buffer.from(challengeCompiled).toString("base64")}`
);

const registrationChallenge = "R".repeat(43);
const authenticationChallenge = "A".repeat(43);

function challengeHarness({ secure = true, signedCookieResult } = {}) {
  const records = new Map();
  const signedWrites = [];
  const cleared = [];
  let currentLookup = null;
  let consumeCount = 0;

  const context = {
    context: {
      secret: "synthetic-test-signing-key-not-a-real-secret",
      createAuthCookie(suffix, overrides) {
        return {
          name: `delta-auth.${suffix}`,
          attributes: {
            secure,
            sameSite: "lax",
            path: "/",
            httpOnly: true,
            ...overrides,
          },
        };
      },
      internalAdapter: {
        async createVerificationValue(record) {
          records.set(record.identifier, { id: "row", ...record });
          return { id: "row", ...record };
        },
        async consumeVerificationValue(identifier) {
          consumeCount += 1;
          const record = records.get(identifier) ?? null;
          records.delete(identifier);
          return record;
        },
      },
    },
    async setSignedCookie(name, value, secret, attributes) {
      signedWrites.push({ name, value, secret, attributes });
      currentLookup = value;
      return `${value}.synthetic-signature`;
    },
    async getSignedCookie() {
      return signedCookieResult === undefined
        ? currentLookup
        : signedCookieResult;
    },
    setCookie(name, value, attributes) {
      cleared.push({ name, value, attributes });
    },
  };

  return {
    context,
    records,
    signedWrites,
    cleared,
    get consumeCount() {
      return consumeCount;
    },
  };
}

test("official passkey plugin precedes the Delta schema overlay", () => {
  assert.match(coreSource, /import \{ passkey \} from "@better-auth\/passkey"/);
  assert.match(
    coreSource,
    /import \{ deltaPasskeySchemaOverlayPlugin \} from "\.\/passkey-schema\.js"/,
  );
  const official = coreSource.indexOf("passkey({");
  const overlay = coreSource.indexOf("deltaPasskeySchemaOverlayPlugin,", official);
  const publicBridge = coreSource.indexOf(
    "passkeyPublicPlugin(database, env),",
    overlay,
  );
  assert.ok(official >= 0);
  assert.ok(overlay > official);
  assert.ok(publicBridge > overlay);
  assert.match(coreSource, /rpID: env\.webauthn\.rpId/);
  assert.match(coreSource, /rpName: env\.webauthn\.rpName/);
  assert.match(coreSource, /origin: env\.webauthn\.origin/);
  assert.match(coreSource, /userVerification:\s*env\.webauthn\.userVerification/);
  assert.match(coreSource, /residentKey:\s*env\.webauthn\.residentKey/);
  assert.match(coreSource, /requireResidentKey:\s*env\.webauthn\.requireResidentKey/);
  assert.doesNotMatch(coreSource, /advancedFIDOConfig/);
  assert.match(installedPasskeySource, /attestationType: "none"/);
});

test("C2 internal enrollment endpoints are programmatic-only and preserve raw containment", () => {
  const expected = [
    "/delta-passkey/enrollment/options",
    "/delta-passkey/enrollment/verify",
  ];
  const declared = [
    ...publicPluginSource.matchAll(
      /"(\/delta-passkey\/enrollment\/(?:options|verify))"/g,
    ),
  ].map((match) => match[1]);
  assert.deepEqual([...new Set(declared)].sort(), expected);
  for (const path of expected) {
    assert.equal(coreSource.split(`"${path}"`).length - 1, 1);
  }
  assert.match(
    coreSource,
    /passkeyPublicPlugin\(database, env\)/,
  );
  assert.match(
    publicPluginSource,
    /createAuthEndpoint/,
  );
  assert.doesNotMatch(
    publicPluginSource,
    /@simplewebauthn\/server|verifyRegistrationResponse|expectedOrigin|expectedRPID/,
  );
});

test("all and only the seven installed raw passkey routes are disabled", () => {
  const expected = [
    "/passkey/generate-register-options",
    "/passkey/generate-authenticate-options",
    "/passkey/verify-registration",
    "/passkey/verify-authentication",
    "/passkey/list-user-passkeys",
    "/passkey/delete-passkey",
    "/passkey/update-passkey",
  ];
  const installed = [
    ...installedPasskeySource.matchAll(
      /createAuthEndpoint\("(\/passkey\/[^"?]+)"/g,
    ),
  ].map((match) => match[1]);
  assert.deepEqual([...new Set(installed)].sort(), [...expected].sort());
  for (const route of expected) {
    assert.equal(coreSource.split(`"${route}"`).length - 1, 1);
  }
  assert.equal(
    [...coreSource.matchAll(/"\/passkey\/[^"?]+"/g)].length,
    7,
  );

  for (const existing of [
    "/two-factor/enable",
    "/two-factor/disable",
    "/two-factor/verify-totp",
    "/two-factor/verify-backup-code",
    "/delta-recovery/verify",
  ]) {
    assert.ok(coreSource.includes(`"${existing}"`));
  }
});

test("challenge creation stores a bounded payload and only a signed opaque lookup cookie", async () => {
  const harness = challengeHarness({ secure: true });
  const before = Date.now();
  const created = await challengeModule.createPasskeyChallenge(
    harness.context,
    {
      ceremony: "registration",
      challenge: registrationChallenge,
      userId: "user-a",
    },
  );
  const after = Date.now();

  assert.match(
    created.identifier,
    /^delta:webauthn:registration:[A-Za-z0-9_-]{43}$/,
  );
  assert.equal(challengeModule.PASSKEY_LOOKUP_RANDOM_BYTES, 32);
  assert.equal(challengeModule.PASSKEY_LOOKUP_RANDOM_ENTROPY_BITS, 256);
  assert.equal(challengeModule.PASSKEY_CHALLENGE_TTL_SECONDS, 300);
  assert.ok(created.expiresAt.getTime() >= before + 300_000);
  assert.ok(created.expiresAt.getTime() <= after + 300_000);

  const stored = harness.records.get(created.identifier);
  assert.equal(stored.identifier, created.identifier);
  assert.equal(stored.expiresAt, created.expiresAt);
  assert.deepEqual(JSON.parse(stored.value), {
    version: 1,
    ceremony: "registration",
    challenge: registrationChallenge,
    userId: "user-a",
  });

  assert.equal(harness.signedWrites.length, 1);
  const cookie = harness.signedWrites[0];
  assert.equal(cookie.value, created.identifier);
  assert.equal(cookie.value.includes(registrationChallenge), false);
  assert.equal(cookie.value.includes("user-a"), false);
  assert.equal(cookie.attributes.httpOnly, true);
  assert.equal(cookie.attributes.secure, true);
  assert.equal(cookie.attributes.sameSite, "lax");
  assert.equal(cookie.attributes.path, "/api");
  assert.equal(cookie.attributes.maxAge, 300);
  assert.equal("domain" in cookie.attributes, false);
});

test("registration is user-bound while authentication may start unbound", async () => {
  const invalid = challengeHarness();
  await assert.rejects(
    challengeModule.createPasskeyChallenge(invalid.context, {
      ceremony: "registration",
      challenge: registrationChallenge,
    }),
    /Invalid passkey challenge input/,
  );

  const authentication = challengeHarness();
  const created = await challengeModule.createPasskeyChallenge(
    authentication.context,
    {
      ceremony: "authentication",
      challenge: authenticationChallenge,
    },
  );
  assert.equal(
    JSON.parse(authentication.records.get(created.identifier).value).userId,
    null,
  );
});

test("atomic consume gives the challenge to only the first claimant", async () => {
  const harness = challengeHarness();
  await challengeModule.createPasskeyChallenge(harness.context, {
    ceremony: "registration",
    challenge: registrationChallenge,
    userId: "user-a",
  });

  const first = await challengeModule.claimPasskeyChallenge(harness.context, {
    ceremony: "registration",
    userId: "user-a",
  });
  const second = await challengeModule.claimPasskeyChallenge(harness.context, {
    ceremony: "registration",
    userId: "user-a",
  });
  assert.equal(first.challenge, registrationChallenge);
  assert.equal(second, null);
  assert.equal(harness.consumeCount, 2);
  assert.match(challengeSource, /consumeVerificationValue\(identifier\)/);
  assert.doesNotMatch(
    challengeSource,
    /findVerificationValue|deleteVerificationByIdentifier/,
  );
});

test("ceremony and registration-user confusion fail closed", async () => {
  const kindHarness = challengeHarness();
  await challengeModule.createPasskeyChallenge(kindHarness.context, {
    ceremony: "registration",
    challenge: registrationChallenge,
    userId: "user-a",
  });
  assert.equal(
    await challengeModule.claimPasskeyChallenge(kindHarness.context, {
      ceremony: "authentication",
    }),
    null,
  );
  assert.equal(kindHarness.consumeCount, 0);

  const userHarness = challengeHarness();
  await challengeModule.createPasskeyChallenge(userHarness.context, {
    ceremony: "registration",
    challenge: registrationChallenge,
    userId: "user-a",
  });
  assert.equal(
    await challengeModule.claimPasskeyChallenge(userHarness.context, {
      ceremony: "registration",
      userId: "user-b",
    }),
    null,
  );
  assert.equal(userHarness.consumeCount, 1);
});

test("expired, malformed and tampered challenge state is rejected", async () => {
  const missing = challengeHarness();
  assert.equal(
    await challengeModule.claimPasskeyChallenge(missing.context, {
      ceremony: "authentication",
    }),
    null,
  );
  assert.equal(missing.consumeCount, 0);

  const expired = challengeHarness();
  const expiredCreated = await challengeModule.createPasskeyChallenge(
    expired.context,
    {
      ceremony: "authentication",
      challenge: authenticationChallenge,
    },
  );
  expired.records.get(expiredCreated.identifier).expiresAt = new Date(0);
  assert.equal(
    await challengeModule.claimPasskeyChallenge(expired.context, {
      ceremony: "authentication",
    }),
    null,
  );

  const malformed = challengeHarness();
  const malformedCreated = await challengeModule.createPasskeyChallenge(
    malformed.context,
    {
      ceremony: "authentication",
      challenge: authenticationChallenge,
    },
  );
  malformed.records.get(malformedCreated.identifier).value = "not-json";
  assert.equal(
    await challengeModule.claimPasskeyChallenge(malformed.context, {
      ceremony: "authentication",
    }),
    null,
  );

  const tampered = challengeHarness({ signedCookieResult: false });
  assert.equal(
    await challengeModule.claimPasskeyChallenge(tampered.context, {
      ceremony: "authentication",
    }),
    null,
  );
  assert.equal(tampered.consumeCount, 0);
});

test("storage failures propagate for a later transaction rollback", async () => {
  const harness = challengeHarness();
  await challengeModule.createPasskeyChallenge(harness.context, {
    ceremony: "authentication",
    challenge: authenticationChallenge,
  });
  harness.context.context.internalAdapter.consumeVerificationValue = async () => {
    throw new Error("synthetic storage failure");
  };
  await assert.rejects(
    challengeModule.claimPasskeyChallenge(harness.context, {
      ceremony: "authentication",
    }),
    /synthetic storage failure/,
  );
});

test("lookup cookie clearing is explicit and preserves security attributes", () => {
  const harness = challengeHarness({ secure: true });
  challengeModule.clearPasskeyLookupCookie(harness.context);
  assert.deepEqual(harness.cleared, [
    {
      name: "delta-auth.delta_passkey_challenge",
      value: "",
      attributes: {
        secure: true,
        sameSite: "lax",
        path: "/api",
        httpOnly: true,
        maxAge: 0,
      },
    },
  ]);
});

test("I4 remains storage and containment only", () => {
  assert.match(challengeSource, /createVerificationValue/);
  assert.match(challengeSource, /consumeVerificationValue/);
  assert.doesNotMatch(
    challengeSource,
    /generateRegistrationOptions|verifyRegistrationResponse|generateAuthenticationOptions|verifyAuthenticationResponse/,
  );
  assert.doesNotMatch(
    challengeSource,
    /createSession|setSessionCookie|passkey-rate-limit|mfa-security-audit/,
  );
  assert.doesNotMatch(coreSource + challengeSource, /\/api\/v1\/[^"'\s]*passkey/);
  assert.doesNotMatch(challengeSource, /SELECT|INSERT INTO|DELETE FROM|UPDATE\s+/i);
});

const ceremonySource = readFileSync("src/auth/passkey-ceremony.ts", "utf8");
const managementProofSource = readFileSync(
  "src/auth/passkey-management-proof.ts",
  "utf8",
);
const counterSource = readFileSync("src/auth/passkey-counter.ts", "utf8");

function compileCommonJs(source, filename, dependencies) {
  const exports = {};
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: filename,
  }).outputText;
  vm.runInNewContext(output, {
    exports,
    module: { exports },
    require(specifier) {
      if (specifier in dependencies) return dependencies[specifier];
      throw new Error(`Unexpected ${filename} test import: ${specifier}`);
    },
    Buffer,
    Date,
    Error,
    Object,
    Set,
    Symbol,
    Uint8Array,
    URL,
  });
  return exports;
}

const plain = (value) => JSON.parse(JSON.stringify(value));

const counterModule = compileCommonJs(
  counterSource,
  "passkey-counter.ts",
  {},
);
const unavailableWebAuthn = async () => {
  throw new Error("real WebAuthn dependency must be overridden in unit tests");
};
const ceremonyModule = compileCommonJs(
  ceremonySource,
  "passkey-ceremony.ts",
  {
    "@simplewebauthn/server": {
      generateAuthenticationOptions: unavailableWebAuthn,
      generateRegistrationOptions: unavailableWebAuthn,
      verifyAuthenticationResponse: unavailableWebAuthn,
      verifyRegistrationResponse: unavailableWebAuthn,
    },
    "./passkey-challenge.js": {
      claimPasskeyChallenge: unavailableWebAuthn,
      createPasskeyChallenge: unavailableWebAuthn,
    },
    "./passkey-counter.js": counterModule,
  },
);

const webauthnConfig = Object.freeze({
  rpId: "example.com",
  rpName: "Delta",
  origin: "https://auth.example.com",
  userVerification: "required",
  attestation: "none",
  residentKey: "preferred",
  requireResidentKey: false,
  requireUserPresence: true,
});
const credentialID = "Y3JlZGVudGlhbC0x";
const publicKeyBytes = Uint8Array.from([1, 2, 3, 4]);
const authenticationResponse = {
  id: credentialID,
  rawId: credentialID,
  response: {
    clientDataJSON: "Y2xpZW50",
    authenticatorData: "YXV0aA",
    signature: "c2ln",
  },
  clientExtensionResults: {},
  type: "public-key",
};

function ceremonyHarness(overrides = {}) {
  const calls = {
    createChallenges: [],
    claimChallenges: [],
    generatedRegistration: [],
    verifiedRegistration: [],
    generatedAuthentication: [],
    verifiedAuthentication: [],
    adapter: [],
  };
  const record = {
    id: "passkey-row-1",
    name: null,
    publicKey: Buffer.from(publicKeyBytes).toString("base64"),
    userId: "user-a",
    credentialID,
    counter: "2147483648",
    deviceType: "multiDevice",
    backedUp: true,
    transports: "internal,hybrid",
    createdAt: new Date("2026-09-11T00:00:00.000Z"),
    aaguid: "00000000-0000-0000-0000-000000000000",
  };
  const adapter = {
    async findMany(input) {
      calls.adapter.push(["findMany", input]);
      return [record];
    },
    async findOne(input) {
      calls.adapter.push(["findOne", input]);
      return record;
    },
    async create(input) {
      calls.adapter.push(["create", input]);
      return { id: "passkey-row-created", ...input.data };
    },
  };
  const dependencies = {
    async generateRegistrationOptions(input) {
      calls.generatedRegistration.push(input);
      return {
        challenge: "R".repeat(43),
        rp: { id: input.rpID, name: input.rpName },
        user: { id: "opaque", name: input.userName, displayName: input.userDisplayName },
        pubKeyCredParams: [],
        attestation: input.attestationType,
        authenticatorSelection: input.authenticatorSelection,
        excludeCredentials: input.excludeCredentials,
      };
    },
    async verifyRegistrationResponse(input) {
      calls.verifiedRegistration.push(input);
      return {
        verified: true,
        registrationInfo: {
          fmt: "none",
          aaguid: record.aaguid,
          credential: {
            id: credentialID,
            publicKey: publicKeyBytes,
            counter: 0,
            transports: ["internal"],
          },
          credentialType: "public-key",
          attestationObject: Uint8Array.from([9]),
          userVerified: true,
          credentialDeviceType: "multiDevice",
          credentialBackedUp: true,
          origin: webauthnConfig.origin,
          rpID: webauthnConfig.rpId,
        },
      };
    },
    async generateAuthenticationOptions(input) {
      calls.generatedAuthentication.push(input);
      return {
        challenge: "A".repeat(43),
        rpId: input.rpID,
        userVerification: input.userVerification,
        ...(input.allowCredentials === undefined
          ? {}
          : { allowCredentials: input.allowCredentials }),
      };
    },
    async verifyAuthenticationResponse(input) {
      calls.verifiedAuthentication.push(input);
      return {
        verified: true,
        authenticationInfo: {
          credentialID,
          newCounter: 2_147_483_649,
          userVerified: true,
          credentialDeviceType: "multiDevice",
          credentialBackedUp: true,
          origin: webauthnConfig.origin,
          rpID: webauthnConfig.rpId,
        },
      };
    },
    async createChallenge(_context, input) {
      calls.createChallenges.push(input);
      return { expiresAt: new Date(), identifier: "server-only" };
    },
    async claimChallenge(_context, input) {
      calls.claimChallenges.push(input);
      return {
        version: 1,
        ceremony: input.ceremony,
        challenge: input.ceremony === "registration" ? "R".repeat(43) : "A".repeat(43),
        userId: input.ceremony === "registration" ? input.userId : null,
      };
    },
    now: () => new Date("2026-09-11T00:00:00.000Z"),
    ...overrides,
  };
  return {
    adapter,
    calls,
    challengeContext: {},
    record,
    services: ceremonyModule.createPasskeyCeremonyServices(dependencies),
  };
}

test("I5 registration options use direct strict policy and user-scoped exclusions", async () => {
  const harness = ceremonyHarness();
  const options = await harness.services.registrationOptions({
    adapter: harness.adapter,
    challengeContext: harness.challengeContext,
    config: webauthnConfig,
    user: { id: "user-a", email: "user@example.com", displayName: "User" },
  });
  assert.equal(options.challenge, "R".repeat(43));
  assert.deepEqual(plain(harness.calls.adapter[0][1].where), [
    { field: "userId", value: "user-a" },
  ]);
  assert.deepEqual(plain(harness.calls.generatedRegistration[0]), {
    rpName: "Delta",
    rpID: "example.com",
    userName: "user@example.com",
    userDisplayName: "User",
    attestationType: "none",
    excludeCredentials: [
      { id: credentialID, transports: ["internal", "hybrid"] },
    ],
    authenticatorSelection: {
      userVerification: "required",
      residentKey: "preferred",
      requireResidentKey: false,
    },
  });
  assert.deepEqual(plain(harness.calls.createChallenges), [
    { ceremony: "registration", challenge: "R".repeat(43), userId: "user-a" },
  ]);
});

test("I5 registration verification binds challenge, origin, RP ID and UV", async () => {
  const harness = ceremonyHarness();
  const result = await harness.services.verifyRegistration({
    adapter: harness.adapter,
    challengeContext: harness.challengeContext,
    config: webauthnConfig,
    userId: "user-a",
    name: "Laptop",
    response: { id: credentialID },
  });
  assert.equal(result.userVerified, true);
  assert.equal(result.userId, "user-a");
  assert.deepEqual(plain(harness.calls.claimChallenges), [
    { ceremony: "registration", userId: "user-a" },
  ]);
  const verification = harness.calls.verifiedRegistration[0];
  assert.equal(verification.expectedChallenge, "R".repeat(43));
  assert.equal(verification.expectedOrigin, webauthnConfig.origin);
  assert.equal(verification.expectedRPID, webauthnConfig.rpId);
  assert.equal(verification.requireUserPresence, true);
  assert.equal(verification.requireUserVerification, true);
  assert.equal("advancedFIDOConfig" in verification, false);

  const inserted = harness.calls.adapter.find(([operation]) => operation === "create")[1];
  assert.equal(inserted.model, "passkey");
  assert.deepEqual(plain(inserted.data), {
    name: "Laptop",
    publicKey: "AQIDBA==",
    userId: "user-a",
    credentialID,
    counter: 0,
    deviceType: "multiDevice",
    backedUp: true,
    transports: "internal",
    createdAt: "2026-09-11T00:00:00.000Z",
    aaguid: "00000000-0000-0000-0000-000000000000",
  });
  assert.doesNotMatch(JSON.stringify(inserted.data), /private|secret/i);
});

test("I5 rejects unverified or non-UV registration before insertion", async () => {
  for (const registrationInfo of [
    undefined,
    {
      credential: { id: credentialID, publicKey: publicKeyBytes, counter: 0 },
      userVerified: false,
    },
  ]) {
    const harness = ceremonyHarness({
      verifyRegistrationResponse: async () => ({
        verified: registrationInfo !== undefined,
        ...(registrationInfo === undefined ? {} : { registrationInfo }),
      }),
    });
    await assert.rejects(
      harness.services.verifyRegistration({
        adapter: harness.adapter,
        challengeContext: harness.challengeContext,
        config: webauthnConfig,
        userId: "user-a",
        response: { id: credentialID },
      }),
      (error) => error.code === "REGISTRATION_REJECTED",
    );
    assert.equal(harness.calls.adapter.some(([operation]) => operation === "create"), false);
  }
});

test("I5 claimed challenge and credential absence fail closed without fallback", async () => {
  const registration = ceremonyHarness({
    claimChallenge: async () => null,
  });
  await assert.rejects(
    registration.services.verifyRegistration({
      adapter: registration.adapter,
      challengeContext: registration.challengeContext,
      config: webauthnConfig,
      userId: "user-a",
      response: { id: credentialID },
    }),
    (error) => error.code === "CHALLENGE_REJECTED",
  );
  assert.equal(registration.calls.verifiedRegistration.length, 0);

  const authentication = ceremonyHarness();
  authentication.adapter.findOne = async () => null;
  await assert.rejects(
    authentication.services.verifyAuthentication({
      adapter: authentication.adapter,
      challengeContext: authentication.challengeContext,
      config: webauthnConfig,
      response: authenticationResponse,
    }),
    (error) => error.code === "AUTHENTICATION_REJECTED",
  );
  assert.equal(authentication.calls.verifiedAuthentication.length, 0);
});

test("I5 maps only the global credential uniqueness race to stable conflict", async () => {
  const harness = ceremonyHarness();
  harness.adapter.create = async () => {
    const error = new Error("sentinel SQL text");
    error.code = "23505";
    error.constraint = "passkey_credentialID_key";
    throw error;
  };
  await assert.rejects(
    harness.services.verifyRegistration({
      adapter: harness.adapter,
      challengeContext: harness.challengeContext,
      config: webauthnConfig,
      userId: "user-a",
      response: { id: credentialID },
    }),
    (error) =>
      error.code === "CREDENTIAL_CONFLICT" &&
      !error.message.includes("sentinel SQL text"),
  );
});

test("I5 public-key encoding is exact standard Base64 and strict on decode", () => {
  assert.equal(ceremonyModule.encodePasskeyPublicKey(publicKeyBytes), "AQIDBA==");
  assert.deepEqual(
    [...ceremonyModule.decodePasskeyPublicKey("AQIDBA==")],
    [...publicKeyBytes],
  );
  for (const invalid of ["", "AQIDBA", "AQIDBA=", "AQIDBA===", "AQIDBA== ", "****"])
    assert.throws(() => ceremonyModule.decodePasskeyPublicKey(invalid));
  for (const invalid of ["", "abc=", "ABC+", "ABC/", "a b", "01=="])
    assert.throws(() => ceremonyModule.canonicalCredentialId(invalid));
});

test("I5 authentication options are discoverable by default and optionally user-scoped", async () => {
  const discoverable = ceremonyHarness();
  await discoverable.services.authenticationOptions({
    adapter: discoverable.adapter,
    challengeContext: discoverable.challengeContext,
    config: webauthnConfig,
  });
  assert.deepEqual(plain(discoverable.calls.generatedAuthentication[0]), {
    rpID: "example.com",
    userVerification: "required",
  });
  assert.deepEqual(plain(discoverable.calls.createChallenges[0]), {
    ceremony: "authentication",
    challenge: "A".repeat(43),
  });

  const known = ceremonyHarness();
  await known.services.authenticationOptions({
    adapter: known.adapter,
    challengeContext: known.challengeContext,
    config: webauthnConfig,
    authoritativeUserId: "user-a",
  });
  assert.deepEqual(plain(known.calls.adapter[0][1].where), [
    { field: "userId", value: "user-a" },
  ]);
  assert.deepEqual(plain(known.calls.generatedAuthentication[0].allowCredentials), [
    { id: credentialID, transports: ["internal", "hybrid"] },
  ]);
});

test("I5 authentication derives user and verifier credential from the stored row", async () => {
  const harness = ceremonyHarness();
  const result = await harness.services.verifyAuthentication({
    adapter: harness.adapter,
    challengeContext: harness.challengeContext,
    config: webauthnConfig,
    response: { ...authenticationResponse, userId: "attacker-controlled" },
  });
  assert.equal(result.userId, "user-a");
  assert.equal(result.passkeyId, "passkey-row-1");
  assert.equal(result.newCounter, 2_147_483_649);
  assert.equal(result.userVerified, true);
  assert.equal(result.credentialDeviceType, "multiDevice");
  assert.equal(result.credentialBackedUp, true);
  assert.equal("assuranceLevel" in result, false);
  assert.deepEqual(plain(harness.calls.adapter[0][1].where), [
    { field: "credentialID", value: credentialID },
  ]);
  const verification = harness.calls.verifiedAuthentication[0];
  assert.equal(verification.expectedChallenge, "A".repeat(43));
  assert.equal(verification.expectedOrigin, webauthnConfig.origin);
  assert.equal(verification.expectedRPID, webauthnConfig.rpId);
  assert.equal(verification.requireUserVerification, true);
  assert.equal("advancedFIDOConfig" in verification, false);
  assert.equal(verification.credential.id, credentialID);
  assert.equal(verification.credential.counter, 2_147_483_648);
  assert.deepEqual([...verification.credential.publicKey], [...publicKeyBytes]);
});

test("I5 fails closed on invalid stored counters before crypto verification", async () => {
  for (const counter of ["4294967296", -1, 1.5, "01", null]) {
    const harness = ceremonyHarness();
    harness.record.counter = counter;
    await assert.rejects(
      harness.services.verifyAuthentication({
        adapter: harness.adapter,
        challengeContext: harness.challengeContext,
        config: webauthnConfig,
        response: authenticationResponse,
      }),
    );
    assert.equal(harness.calls.verifiedAuthentication.length, 0);
  }
  for (const counter of [0, "2147483648", 4_294_967_295]) {
    const harness = ceremonyHarness();
    harness.record.counter = counter;
    await harness.services.verifyAuthentication({
      adapter: harness.adapter,
      challengeContext: harness.challengeContext,
      config: webauthnConfig,
      response: authenticationResponse,
    });
    assert.equal(harness.calls.verifiedAuthentication.length, 1);
  }
});

test("I5 rejects false verification, false UV and invalid newCounter without persistence", async () => {
  for (const verification of [
    {
      verified: false,
      authenticationInfo: {
        credentialID,
        newCounter: 1,
        userVerified: true,
        credentialDeviceType: "singleDevice",
        credentialBackedUp: false,
      },
    },
    {
      verified: true,
      authenticationInfo: {
        credentialID,
        newCounter: 1,
        userVerified: false,
        credentialDeviceType: "singleDevice",
        credentialBackedUp: false,
      },
    },
    {
      verified: true,
      authenticationInfo: {
        credentialID,
        newCounter: 4_294_967_296,
        userVerified: true,
        credentialDeviceType: "singleDevice",
        credentialBackedUp: false,
      },
    },
  ]) {
    const harness = ceremonyHarness({
      verifyAuthenticationResponse: async () => verification,
    });
    await assert.rejects(
      harness.services.verifyAuthentication({
        adapter: harness.adapter,
        challengeContext: harness.challengeContext,
        config: webauthnConfig,
        response: authenticationResponse,
      }),
    );
    assert.equal(
      harness.calls.adapter.some(([operation]) => operation === "update"),
      false,
    );
  }
});

test("I5 sanitizes raw SimpleWebAuthn verifier errors", async () => {
  for (const [method, invoke] of [
    [
      "verifyRegistrationResponse",
      (harness) => harness.services.verifyRegistration({
        adapter: harness.adapter,
        challengeContext: harness.challengeContext,
        config: webauthnConfig,
        userId: "user-a",
        response: { id: credentialID },
      }),
    ],
    [
      "verifyAuthenticationResponse",
      (harness) => harness.services.verifyAuthentication({
        adapter: harness.adapter,
        challengeContext: harness.challengeContext,
        config: webauthnConfig,
        response: authenticationResponse,
      }),
    ],
  ]) {
    const harness = ceremonyHarness({
      [method]: async () => {
        throw new Error("SENSITIVE_SENTINEL_CHALLENGE_MATERIAL");
      },
    });
    await assert.rejects(
      invoke(harness),
      (error) => !error.message.includes("SENSITIVE_SENTINEL_CHALLENGE_MATERIAL"),
    );
  }
});

const managementDigestCalls = [];
const managementProofModule = compileCommonJs(
  managementProofSource,
  "passkey-management-proof.ts",
  {
    "./password-policy.js": {
      AUTH_PASSWORD_MIN_LENGTH: 15,
      AUTH_PASSWORD_MAX_LENGTH: 128,
    },
    "./totp-replay.js": {
      createTotpReplayDigest(pepper, userId, code) {
        managementDigestCalls.push({ pepper, userId, code });
        return "d".repeat(64);
      },
    },
    "./totp-replacement.js": {
      isValidTotpCode: (value) => /^[0-9]{6}$/.test(value),
      verifyEncryptedTotpCode: unavailableWebAuthn,
    },
  },
);

function trustedManagementContext(origin = "https://auth.example.com") {
  return managementProofModule.createTrustedPasskeyManagementContext({
    session: { userId: "user-a", sessionId: "session-a" },
    requestOrigin: origin,
    trustedOrigins: ["https://auth.example.com"],
  });
}

function managementDependencies(state, overrides = {}) {
  const calls = { loaded: [], passwords: [], totp: [], replay: [] };
  const acceptedAt = new Date("2026-09-11T00:00:00.000Z");
  return {
    calls,
    value: {
      async loadSecurityState(input) {
        calls.loaded.push(input);
        return state;
      },
      async verifyPassword(input) {
        calls.passwords.push(input);
        return true;
      },
      async claimTotpReplay(input) {
        calls.replay.push(input);
        return true;
      },
      async verifyTotp(key, secret, code) {
        calls.totp.push({ key, secret, code });
        return true;
      },
      encryptionKey: "e".repeat(32),
      replayPepper: "r".repeat(32),
      now: () => new Date(acceptedAt),
      ...overrides,
    },
  };
}

test("I5 management proof requires exact trusted origin and session identity", () => {
  assert.equal(trustedManagementContext().userId, "user-a");
  for (const origin of [
    undefined,
    "https://evil.example.com",
    "https://auth.example.com/path",
    "https://user:pass@auth.example.com",
  ]) {
    assert.throws(() =>
      managementProofModule.createTrustedPasskeyManagementContext({
        session: { userId: "user-a", sessionId: "session-a" },
        requestOrigin: origin,
        trustedOrigins: ["https://auth.example.com"],
      }),
    );
  }
});

test("I5 management proof always requires Better Auth current-password verification", async () => {
  const dependencies = managementDependencies({
    sessionValid: true,
    passwordHash: "stored-password-hash",
    totp: { state: "absent" },
  });
  const result = await managementProofModule.verifyPasskeyManagementFreshProof(
    trustedManagementContext(),
    { password: "correct horse battery staple" },
    dependencies.value,
  );
  assert.deepEqual(plain(dependencies.calls.loaded[0]), {
    userId: "user-a",
    sessionId: "session-a",
    observedAt: "2026-09-11T00:00:00.000Z",
  });
  assert.deepEqual(plain(dependencies.calls.passwords), [
    { hash: "stored-password-hash", password: "correct horse battery staple" },
  ]);
  assert.deepEqual([...result.methods], ["password"]);
  assert.equal("token" in result, false);
  assert.equal("recovery" in result, false);

  assert.equal(
    await managementProofModule.verifyPasskeyManagementFreshProof(
      trustedManagementContext(),
      { password: "" },
      dependencies.value,
    ),
    null,
  );
});

test("I5 active TOTP proof reuses encryption verification and durable replay claim", async () => {
  managementDigestCalls.length = 0;
  const dependencies = managementDependencies({
    sessionValid: true,
    passwordHash: "stored-password-hash",
    totp: {
      state: "active",
      encryptedSecret: "encrypted-totp-secret",
      lockedUntil: null,
    },
  });
  const result = await managementProofModule.verifyPasskeyManagementFreshProof(
    trustedManagementContext(),
    { password: "correct horse battery staple", totpCode: "123456" },
    dependencies.value,
  );
  assert.deepEqual(dependencies.calls.totp, [
    {
      key: "e".repeat(32),
      secret: "encrypted-totp-secret",
      code: "123456",
    },
  ]);
  assert.deepEqual(managementDigestCalls, [
    { pepper: "r".repeat(32), userId: "user-a", code: "123456" },
  ]);
  assert.equal(dependencies.calls.replay.length, 1);
  assert.equal(dependencies.calls.replay[0].codeDigest, "d".repeat(64));
  assert.equal(
    dependencies.calls.replay[0].expiresAt.getTime() -
      dependencies.calls.replay[0].acceptedAt.getTime(),
    300_000,
  );
  assert.deepEqual([...result.methods], ["password", "totp"]);
});

test("I5 active TOTP and replay failures fail closed", async () => {
  const active = {
    sessionValid: true,
    passwordHash: "stored-password-hash",
    totp: {
      state: "active",
      encryptedSecret: "encrypted-totp-secret",
      lockedUntil: null,
    },
  };
  for (const [proof, overrides] of [
    [{ password: "correct horse battery staple" }, {}],
    [
      { password: "correct horse battery staple", totpCode: "123456" },
      { verifyTotp: async () => false },
    ],
    [
      { password: "correct horse battery staple", totpCode: "123456" },
      { claimTotpReplay: async () => false },
    ],
  ]) {
    const dependencies = managementDependencies(active, overrides);
    assert.equal(
      await managementProofModule.verifyPasskeyManagementFreshProof(
        trustedManagementContext(),
        proof,
        dependencies.value,
      ),
      null,
    );
  }

  const locked = managementDependencies({
    ...active,
    totp: {
      ...active.totp,
      lockedUntil: new Date("2026-09-11T00:01:00.000Z"),
    },
  });
  assert.equal(
    await managementProofModule.verifyPasskeyManagementFreshProof(
      trustedManagementContext(),
      { password: "correct horse battery staple", totpCode: "123456" },
      locked.value,
    ),
    null,
  );
  assert.equal(locked.calls.totp.length, 0);
});

test("I5 source boundary has no final auth state transition or public route", () => {
  assert.match(ceremonySource, /from "@simplewebauthn\/server"/);
  assert.match(ceremonySource, /generateRegistrationOptions/);
  assert.match(ceremonySource, /verifyRegistrationResponse/);
  assert.match(ceremonySource, /generateAuthenticationOptions/);
  assert.match(ceremonySource, /verifyAuthenticationResponse/);
  assert.match(ceremonySource, /passkeyCounterFromDatabase/);
  assert.match(managementProofSource, /verifyEncryptedTotpCode/);
  assert.match(managementProofSource, /createTotpReplayDigest/);
  assert.doesNotMatch(
    ceremonySource + managementProofSource,
    /createSession|setSessionCookie|passkeySessionMarker|runWithTransaction|\/api\/v1/,
  );
  assert.doesNotMatch(ceremonySource, /adapter\.update|incrementOne/);
  assert.doesNotMatch(ceremonySource, /conditional|mediation|assuranceLevel|trustedDevice/);
  assert.equal(existsSync("src/auth/passkey-plugin.ts"), true);
  assert.equal(existsSync("test/passkey-transaction-contract.test.mjs"), true);
  assert.equal(
    createHash("sha256").update(ceremonySource).digest("hex"),
    "b71e2c814bf437c39614dc327f53817aa1e340ab718781eb3b7d5308ad6b7bcd",
  );
  assert.equal(
    createHash("sha256").update(readFileSync("src/auth/passkey-challenge.ts")).digest("hex"),
    "1915741e12a7ebaf348989afc0e20b98abd034f1c1d043e6e92a1bc4380b2f91",
  );
  assert.equal(
    createHash("sha256")
      .update(readFileSync("migrations/0007_webauthn_passkey_foundation.sql"))
      .digest("hex"),
    "18c144b5bd017e0ec7e28e4701a894fa8e723e941cec9e8663b6a5dbb3953a10",
  );
});

const i7RateLimitSource = readFileSync(
  "src/storage/passkey-rate-limit.ts",
  "utf8",
);
const i7AuditSource = readFileSync(
  "src/auth/mfa-security-audit.ts",
  "utf8",
);
const i7PluginSource = readFileSync("src/auth/passkey-plugin.ts", "utf8");

function loadCommonJs(source, fileName, imports, globals = {}) {
  const moduleExports = {};
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName,
  }).outputText;
  vm.runInNewContext(output, {
    exports: moduleExports,
    module: { exports: moduleExports },
    require(specifier) {
      if (specifier in imports) return imports[specifier];
      throw new Error(`Unexpected I7 test import: ${specifier}`);
    },
    Buffer,
    Date,
    Error,
    JSON,
    Number,
    Object,
    Set,
    ...globals,
  });
  return moduleExports;
}

const i7RateLimit = loadCommonJs(
  i7RateLimitSource,
  "passkey-rate-limit.ts",
  { "node:crypto": { createHmac } },
);

class I7CeremonyError extends Error {
  constructor(code, detail = "synthetic-sensitive-error") {
    super(detail);
    this.code = code;
  }
}

const i7Plugin = loadCommonJs(
  i7PluginSource,
  "passkey-plugin.ts",
  {
    "@better-auth/core/context": {
      getCurrentAdapter: async (adapter) => adapter,
      runWithTransaction: async (_adapter, fn) => fn(),
    },
    "better-auth/cookies": { setSessionCookie: async () => undefined },
    "./passkey-ceremony.js": {
      PasskeyCeremonyError: I7CeremonyError,
      passkeyCeremonyServices: {
        verifyAuthentication: async () => {
          throw new Error("unused production ceremony dependency");
        },
      },
    },
    "./passkey-challenge.js": {
      clearPasskeyLookupCookie: () => undefined,
    },
    "./passkey-counter.js": {
      passkeyCounterFromDatabase(value) {
        const parsed = Number(value);
        if (!Number.isSafeInteger(parsed)) throw new Error("invalid counter");
        return parsed;
      },
      passkeyCounterToDatabase(value) {
        if (!Number.isSafeInteger(value)) throw new Error("invalid counter");
        return String(value);
      },
    },
    "../storage/passkey-session-marker.js": {
      insertPasskeySessionMarker: async () => undefined,
    },
  },
);

function loadI7Audit(log = () => undefined) {
  return loadCommonJs(
    i7AuditSource,
    "mfa-security-audit.ts",
    {},
    { console: { log } },
  );
}

test("I7 passkey rate-limit policy reuses accepted Recovery budgets", () => {
  assert.equal(
    i7RateLimit.PASSKEY_RATE_LIMIT_POLICY_SOURCE,
    "DELTA_RECOVERY_CHALLENGE_AND_MUTATION_BUDGETS",
  );
  for (const operation of ["registrationOptions", "authenticationOptions"]) {
    assert.equal(i7RateLimit.PASSKEY_RATE_LIMIT_POLICIES[operation].limit, 3);
    assert.equal(i7RateLimit.PASSKEY_RATE_LIMIT_POLICIES[operation].seconds, 10);
  }
  for (const operation of [
    "registrationVerify",
    "authenticationVerify",
    "managementFreshProof",
  ]) {
    assert.equal(i7RateLimit.PASSKEY_RATE_LIMIT_POLICIES[operation].limit, 5);
    assert.equal(i7RateLimit.PASSKEY_RATE_LIMIT_POLICIES[operation].seconds, 900);
  }
  assert.equal(i7RateLimit.PASSKEY_RATE_LIMIT_POLICIES.managementList.limit, 60);
  assert.equal(i7RateLimit.PASSKEY_RATE_LIMIT_POLICIES.managementList.seconds, 60);
  for (const operation of ["managementRename", "managementDelete"]) {
    assert.equal(i7RateLimit.PASSKEY_RATE_LIMIT_POLICIES[operation].limit, 5);
    assert.equal(i7RateLimit.PASSKEY_RATE_LIMIT_POLICIES[operation].seconds, 900);
  }
  assert.doesNotMatch(i7RateLimitSource, /PASSKEY_RATE_LIMIT_PEPPER|WEBAUTHN_RATE_LIMIT_SECRET/);
});

test("I7 limiter identities are stable full HMACs with operation separation", () => {
  const key = "accepted-existing-key-material-01234567890123456789";
  const sourceIdentity = "synthetic-network-principal";
  const registration = i7RateLimit.passkeyBucketId(
    key,
    "registrationOptionsIp",
    sourceIdentity,
  );
  assert.match(registration, /^[0-9a-f]{64}$/);
  assert.equal(Buffer.from(registration, "hex").byteLength, 32);
  assert.equal(
    registration,
    i7RateLimit.passkeyBucketId(key, "registrationOptionsIp", sourceIdentity),
  );
  assert.notEqual(
    registration,
    i7RateLimit.passkeyBucketId(key, "authenticationOptionsIp", sourceIdentity),
  );
  assert.notEqual(
    registration,
    i7RateLimit.passkeyBucketId(key, "registrationOptionsIp", "different-principal"),
  );
  assert.equal(registration.includes(sourceIdentity), false);
});

test("I7 fixed operation API uses one parameterized atomic durable update", async () => {
  const calls = [];
  const key = "accepted-existing-key-material-01234567890123456789";
  const rawIdentity = "synthetic-user-principal";
  const takeDurableLimit = i7RateLimit.createPasskeyDurableRateLimiter(
    {
      async query(statement, values = []) {
        calls.push({ statement, values });
        return { rowCount: /RETURNING id/.test(statement) ? 1 : 0, rows: [] };
      },
    },
    key,
  );
  const allowed = await takeDurableLimit({
    operation: "managementFreshProof",
    identity: { kind: "user", source: rawIdentity },
  });
  assert.equal(allowed, true);
  assert.equal(calls.length, 2);
  assert.match(calls[0].statement, /expires_at <= clock_timestamp\(\)/);
  assert.match(calls[0].statement, /LIMIT 64/);
  assert.match(calls[1].statement, /ON CONFLICT \(id\) DO UPDATE/);
  assert.match(calls[1].statement, /hits < \$3/);
  assert.match(calls[1].statement, /clock_timestamp\(\)/);
  assert.deepEqual(Array.from(calls[1].values).slice(1), [900, 5]);
  assert.match(calls[1].values[0], /^[0-9a-f]{64}$/);
  assert.equal(calls.some((call) => call.values.includes(rawIdentity)), false);
});

test("I7 limiter threshold and expired-window contracts fail closed", async () => {
  const key = "accepted-existing-key-material-01234567890123456789";
  let hits = 0;
  const database = {
    async query(statement, values = []) {
      if (!/RETURNING id/.test(statement)) return { rowCount: 0, rows: [] };
      hits += 1;
      return { rowCount: hits <= values[2] ? 1 : 0, rows: [] };
    },
  };
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.equal(
      await i7RateLimit.takePasskeyOperationRateLimit(
        database,
        key,
        "authenticationVerify",
        "network",
        "synthetic-network-principal",
      ),
      true,
    );
  }
  assert.equal(
    await i7RateLimit.takePasskeyOperationRateLimit(
      database,
      key,
      "authenticationVerify",
      "network",
      "synthetic-network-principal",
    ),
    false,
  );
  await assert.rejects(
    i7RateLimit.takePasskeyOperationRateLimit(
      { async query() { throw new Error("sentinel-database-detail"); } },
      key,
      "authenticationVerify",
      "network",
      "synthetic-network-principal",
    ),
    (error) =>
      error.message === "Passkey rate-limit storage unavailable." &&
      !error.message.includes("sentinel"),
  );
  assert.match(i7RateLimitSource, /CASE WHEN[\s\S]*expires_at <= clock_timestamp\(\)[\s\S]*THEN 1/);
});

test("I7 passkey audit actions and outcomes are finite allowlists", () => {
  const entries = [];
  const audit = loadI7Audit((entry) => entries.push(entry));
  assert.deepEqual(Array.from(audit.PASSKEY_SECURITY_ACTIONS), [
    "passkey_registration",
    "passkey_authentication",
    "passkey_management_fresh_proof",
    "passkey_management_list",
    "passkey_management_rename",
    "passkey_management_delete",
    "passkey_rate_limit",
    "passkey_security_failure",
  ]);
  audit.logPasskeySecurityAuditEvent(
    "server-request-id",
    "passkey_authentication",
    "success",
    { userVerified: true },
  );
  assert.equal(entries.length, 1);
  assert.throws(() =>
    audit.logPasskeySecurityAuditEvent(
      "server-request-id",
      "arbitrary_action",
      "success",
      {},
    ),
  );
  assert.throws(() =>
    audit.logMfaSecurityAuditEvent(
      "server-request-id",
      "arbitrary_action",
      "success",
    ),
  );
});

test("I5 management rate classes are user scoped and preserve durable privacy", async () => {
  const calls = [];
  const limiter = i7RateLimit.createPasskeyDurableRateLimiter(
    {
      async query(statement, values = []) {
        calls.push({ statement, values });
        return { rowCount: /RETURNING id/.test(statement) ? 1 : 0, rows: [] };
      },
    },
    "accepted-existing-key-material-01234567890123456789",
  );
  for (const operation of ["managementList", "managementRename", "managementDelete"]) {
    assert.equal(await limiter({
      operation,
      identity: { kind: "user", source: "synthetic-authoritative-user" },
    }), true);
  }
  assert.equal(calls.some(({ values }) => values.includes("synthetic-authoritative-user")), false);
  await assert.rejects(limiter({
    operation: "managementList",
    identity: { kind: "network", source: "synthetic-network" },
  }));
});

test("I5 management perimeter maps finite storage results without sensitive metadata", async () => {
  for (const scenario of [
    ["managementRename", "not_found", "not_found", "PASSKEY_NOT_FOUND"],
    ["managementDelete", "last_login_method_required", "last_login_method_required", "PASSKEY_LAST_LOGIN_METHOD_REQUIRED"],
    ["managementList", "unavailable", "unavailable", "PASSKEY_UNAVAILABLE"],
  ]) {
    const state = i7PerimeterFixture();
    const result = await state.perimeter.execute({
      operation: scenario[0],
      requestId: "server-request-id",
      identities: [{ kind: "user", source: "synthetic-authoritative-user" }],
      async run() { return { status: scenario[1], secretSentinel: "must-not-leak" }; },
      classify(value) {
        if (value.status === "not_found") {
          return { status: "not_found", code: "PASSKEY_NOT_FOUND", outcome: "rejected" };
        }
        if (value.status === "last_login_method_required") {
          return { status: "last_login_method_required", code: "PASSKEY_LAST_LOGIN_METHOD_REQUIRED", outcome: "conflict" };
        }
        return { status: "unavailable", code: "PASSKEY_UNAVAILABLE", outcome: "internal_failure" };
      },
    });
    assert.equal(result.status, scenario[2]);
    assert.equal(result.error.code, scenario[3]);
    assert.equal(JSON.stringify(result).includes("must-not-leak"), false);
    assert.equal(JSON.stringify(state.audits).includes("must-not-leak"), false);
  }
});

test("I7 audit metadata retains only coarse allowlisted passkey facts", () => {
  const entries = [];
  const audit = loadI7Audit((entry) => entries.push(entry));
  const sentinel = "synthetic-sensitive-sentinel";
  audit.logPasskeySecurityAuditEvent(
    "server-request-id",
    "passkey_authentication",
    "rejected",
    {
      reason: "credential_rejected",
      userVerified: false,
      credentialDeviceType: "singleDevice",
      credentialBackedUp: false,
      challenge: sentinel,
      credentialID: sentinel,
      publicKey: sentinel,
      clientDataJSON: sentinel,
      authenticatorData: sentinel,
      signature: sentinel,
      attestationObject: sentinel,
      password: sentinel,
      totp: sentinel,
      recoveryCode: sentinel,
      sessionToken: sentinel,
      cookie: sentinel,
      email: sentinel,
      ip: sentinel,
      error: new Error(sentinel),
      aaguid: sentinel,
      transports: sentinel,
    },
  );
  const serialized = entries[0];
  assert.equal(serialized.includes(sentinel), false);
  const payload = JSON.parse(serialized);
  assert.deepEqual(Object.keys(payload).sort(), [
    "action",
    "authMethod",
    "credentialBackedUp",
    "credentialDeviceType",
    "event",
    "outcome",
    "reason",
    "requestId",
    "userVerified",
  ]);
  assert.equal(payload.authMethod, "passkey");
  assert.equal("aaguid" in payload, false);
  assert.equal("transports" in payload, false);
});

test("I7 audit failure remains best-effort and non-authoritative", () => {
  const audit = loadI7Audit(() => {
    throw new Error("synthetic-audit-delivery-failure");
  });
  assert.doesNotThrow(() =>
    audit.tryLogPasskeySecurityAuditEvent(
      "server-request-id",
      "passkey_security_failure",
      "internal_failure",
      { reason: "internal_failure" },
    ),
  );
});

function i7PerimeterFixture(overrides = {}) {
  const events = [];
  const audits = [];
  const perimeter = i7Plugin.createPasskeySecurityPerimeter({
    async takeDurableLimit(input) {
      events.push(`LIMIT:${input.operation}:${input.identity.kind}`);
      if (overrides.limitError) throw new Error("sentinel-rate-store-detail");
      return overrides.allowed !== false;
    },
    emitAudit(event) {
      audits.push(event);
      events.push(`AUDIT:${event.outcome}`);
      if (overrides.auditError) throw new Error("sentinel-audit-detail");
    },
    async authenticate() {
      events.push("I6_AUTHENTICATE");
      if (overrides.authenticationError) {
        throw new Error("sentinel-authentication-infrastructure-detail");
      }
      return { status: overrides.authenticationStatus ?? "authenticated" };
    },
  });
  return { events, audits, perimeter };
}

const i7Identities = Object.freeze([
  Object.freeze({ kind: "network", source: "trusted-network-principal" }),
]);

test("I7 rate-limit rejection precedes and prevents ceremony/challenge work", async () => {
  const state = i7PerimeterFixture({ allowed: false });
  const result = await state.perimeter.execute({
    operation: "registrationOptions",
    requestId: "server-request-id",
    identities: i7Identities,
    async run() {
      state.events.push("CHALLENGE_CONSUME");
      state.events.push("WEBAUTHN_CRYPTO");
      state.events.push("SESSION_CREATE");
      return { impossible: true };
    },
  });
  assert.equal(result.status, "rate_limited");
  assert.equal(result.error.code, "PASSKEY_RATE_LIMITED");
  assert.equal("value" in result, false);
  assert.deepEqual(state.events, [
    "LIMIT:registrationOptions:network",
    "AUDIT:rate_limited",
  ]);
  assert.equal(JSON.stringify(result).includes("trusted-network-principal"), false);
});

test("I7 limiter storage failure fails closed before accepted operations", async () => {
  const state = i7PerimeterFixture({ limitError: true });
  const result = await state.perimeter.execute({
    operation: "authenticationVerify",
    requestId: "server-request-id",
    identities: i7Identities,
    async run() {
      state.events.push("WEBAUTHN_CRYPTO");
      return { status: "authenticated" };
    },
  });
  assert.equal(result.status, "unavailable");
  assert.equal(result.error.code, "PASSKEY_UNAVAILABLE");
  assert.equal(state.events.includes("WEBAUTHN_CRYPTO"), false);
  assert.equal(JSON.stringify(result).includes("sentinel"), false);
  assert.equal(JSON.stringify(state.audits).includes("sentinel"), false);
});

test("I7 wrapper maps success and committed rejection without changing I6", async () => {
  const success = i7PerimeterFixture();
  const successResult = await success.perimeter.authenticate({
    requestId: "server-request-id",
    identities: i7Identities,
    authentication: {},
  });
  assert.equal(successResult.status, "success");
  assert.deepEqual(success.events, [
    "LIMIT:authenticationVerify:network",
    "I6_AUTHENTICATE",
    "AUDIT:success",
  ]);

  const rejected = i7PerimeterFixture({ authenticationStatus: "rejected" });
  const rejectedResult = await rejected.perimeter.authenticate({
    requestId: "server-request-id",
    identities: i7Identities,
    authentication: {},
  });
  assert.equal(rejectedResult.status, "rejected");
  assert.equal(rejectedResult.error.code, "PASSKEY_REQUEST_REJECTED");
  assert.deepEqual(rejected.events, [
    "LIMIT:authenticationVerify:network",
    "I6_AUTHENTICATE",
    "AUDIT:rejected",
  ]);
});

test("I7 finite error taxonomy sanitizes proof, conflict and infrastructure errors", async () => {
  const cases = [
    {
      operation: "registrationVerify",
      error: new I7CeremonyError("AUTHENTICATION_REJECTED"),
      status: "rejected",
      code: "PASSKEY_REQUEST_REJECTED",
    },
    {
      operation: "managementFreshProof",
      value: null,
      status: "rejected",
      code: "PASSKEY_FRESH_PROOF_REJECTED",
    },
    {
      operation: "registrationVerify",
      error: new I7CeremonyError("CREDENTIAL_CONFLICT"),
      status: "conflict",
      code: "PASSKEY_CREDENTIAL_CONFLICT",
    },
    {
      operation: "authenticationVerify",
      error: new Error("sentinel-postgresql-sql-credential-session-token"),
      status: "unavailable",
      code: "PASSKEY_UNAVAILABLE",
    },
  ];
  for (const scenario of cases) {
    const state = i7PerimeterFixture();
    const result = await state.perimeter.execute({
      operation: scenario.operation,
      requestId: "server-request-id",
      identities: i7Identities,
      async run() {
        if (scenario.error) throw scenario.error;
        return scenario.value;
      },
    });
    assert.equal(result.status, scenario.status);
    assert.equal(result.error.code, scenario.code);
    assert.equal(result.error.message, "Passkey request could not be completed.");
    assert.equal(JSON.stringify(result).includes("sentinel"), false);
    assert.equal(JSON.stringify(state.audits).includes("sentinel"), false);
    assert.equal(JSON.stringify(result).includes("credential exists"), false);
    assert.equal(JSON.stringify(result).includes("user exists"), false);
  }
});

test("I7 all sensitive outcomes carry the accepted non-cacheable policy", async () => {
  const scenarios = [
    i7PerimeterFixture(),
    i7PerimeterFixture({ allowed: false }),
    i7PerimeterFixture({ limitError: true }),
  ];
  const results = [];
  results.push(
    await scenarios[0].perimeter.execute({
      operation: "managementFreshProof",
      requestId: "server-request-id",
      identities: i7Identities,
      async run() { return { accepted: true }; },
    }),
    await scenarios[1].perimeter.execute({
      operation: "registrationVerify",
      requestId: "server-request-id",
      identities: i7Identities,
      async run() { return { impossible: true }; },
    }),
    await scenarios[2].perimeter.execute({
      operation: "authenticationOptions",
      requestId: "server-request-id",
      identities: i7Identities,
      async run() { return { impossible: true }; },
    }),
  );
  for (const result of results) {
    assert.equal(result.cachePolicy.cacheControl, "no-store");
    assert.equal(result.cachePolicy.pragma, "no-cache");
    assert.equal("maxAge" in result.cachePolicy, false);
  }
  assert.equal(Object.isFrozen(i7Plugin.PASSKEY_SENSITIVE_RESPONSE_POLICY), true);
});

test("I7 security perimeter adds no route, environment, or transaction rewrite", () => {
  assert.doesNotMatch(i7PluginSource, /createAuthEndpoint|\/api\/v1|express/);
  assert.doesNotMatch(i7PluginSource, /PASSKEY_RATE_LIMIT_PEPPER|WEBAUTHN_RATE_LIMIT_SECRET/);
  assert.doesNotMatch(i7PluginSource, /generateAuthenticationOptions|verifyAuthenticationResponse/);
  assert.match(i7PluginSource, /runWithTransaction/);
  assert.match(i7PluginSource, /passkeyCeremonyServices\.verifyAuthentication/);
  assert.match(i7PluginSource, /COMMIT; no auth cookie exists sooner/);
  assert.match(i7PluginSource, /takeDurableLimit/);
  assert.ok(
    i7PluginSource.indexOf("takeDurableLimit") <
      i7PluginSource.indexOf("value = await input.run()"),
  );
  assert.doesNotMatch(i7AuditSource, /aaguid["':\s]|transports["':\s]/i);
});
