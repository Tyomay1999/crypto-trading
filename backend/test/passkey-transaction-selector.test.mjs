import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(
  "src/auth/passkey-test-transaction-selector.ts",
  "utf8",
);
const module = { exports: {} };
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: "passkey-test-transaction-selector.ts",
}).outputText;

vm.runInNewContext(compiled, {
  exports: module.exports,
  module,
  require(specifier) {
    throw new Error(`Unexpected selector test import: ${specifier}`);
  },
  Error,
  JSON,
  Number,
  Object,
  Set,
});

const {
  PasskeyTestSelectorBindingError,
  createPasskeyTestTransactionSelectorCapability,
  passkeyTestTransactionSelectorSchema,
} = module.exports;

const context = Object.freeze({ kind: "internal-test-context" });

function selector(overrides = {}) {
  return Object.freeze({
    version: 1,
    scenarioId: "FI_COUNTER_UPDATE",
    authorizationId: "authorization-pseudonym",
    attemptId: "attempt-pseudonym",
    fixtureId: "fixture-pseudonym",
    operation: "authentication",
    targetPasskeyId: "passkey-pseudonym",
    ...overrides,
  });
}

function adapterFixture(options = {}) {
  const calls = [];
  const adapter = {
    async create(query) {
      calls.push(query);
      if (options.fail) throw new Error("synthetic adapter failure");
      if (options.mismatch) return { payload: "different" };
      return { payload: query.data.payload };
    },
  };
  return { adapter, calls };
}

test("test-only schema maps only the selector-binding view and disables migration", () => {
  const model = passkeyTestTransactionSelectorSchema.i6FaultSelectorBinding;
  assert.equal(model.modelName, "i6_fault.selector_bind");
  assert.equal(model.disableMigration, true);
  assert.deepEqual(Object.keys(model.fields), ["payload"]);
});

test("missing selector is non-arming and performs no adapter operation", async () => {
  const fixture = adapterFixture();
  const capability = createPasskeyTestTransactionSelectorCapability(
    async () => null,
  );
  const result = await capability.bind({
    adapter: fixture.adapter,
    operation: "authentication",
    context,
  });
  assert.equal(result, "absent");
  assert.equal(fixture.calls.length, 0);
});

test("exact selector binds through the exact supplied transaction adapter", async () => {
  const fixture = adapterFixture();
  const capability = createPasskeyTestTransactionSelectorCapability(
    async (input) => {
      assert.equal(input.context, context);
      assert.equal(input.operation, "authentication");
      return selector();
    },
  );
  const result = await capability.bind({
    adapter: fixture.adapter,
    operation: "authentication",
    context,
  });
  assert.equal(result, "bound");
  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.calls[0].model, "i6FaultSelectorBinding");
  const payload = JSON.parse(fixture.calls[0].data.payload);
  assert.equal(payload.authorizationId, "authorization-pseudonym");
  assert.equal(payload.attemptId, "attempt-pseudonym");
  assert.equal(payload.fixtureId, "fixture-pseudonym");
  assert.equal(payload.operation, "authentication");
});

for (const [label, change] of [
  ["malformed version", { version: 2 }],
  ["blank authorization", { authorizationId: "" }],
  ["stale blank attempt", { attemptId: "" }],
  ["blank fixture", { fixtureId: "" }],
  ["wrong operation", { operation: "registration" }],
  ["wrong scenario for operation", { scenarioId: "FI_REGISTRATION_INSERT" }],
  ["unexpected barrier", { barrierClass: 1, barrierKey: 2 }],
  ["control character", { fixtureId: "fixture\ninvalid" }],
]) {
  test(`${label} is rejected before adapter access`, async () => {
    const fixture = adapterFixture();
    const capability = createPasskeyTestTransactionSelectorCapability(
      async () => selector(change),
    );
    await assert.rejects(
      capability.bind({
        adapter: fixture.adapter,
        operation: "authentication",
        context,
      }),
      PasskeyTestSelectorBindingError,
    );
    assert.equal(fixture.calls.length, 0);
  });
}

test("barrier scenarios require bounded signed int32 keys", async () => {
  const validFixture = adapterFixture();
  const valid = createPasskeyTestTransactionSelectorCapability(async () =>
    selector({
      scenarioId: "CAS2_CONCURRENT_COUNTER_CONFLICT",
      barrierClass: 7,
      barrierKey: 9,
    }),
  );
  assert.equal(
    await valid.bind({
      adapter: validFixture.adapter,
      operation: "authentication",
      context,
    }),
    "bound",
  );

  const invalidFixture = adapterFixture();
  const invalid = createPasskeyTestTransactionSelectorCapability(async () =>
    selector({
      scenarioId: "CAS2_CONCURRENT_COUNTER_CONFLICT",
      barrierClass: 7,
    }),
  );
  await assert.rejects(
    invalid.bind({
      adapter: invalidFixture.adapter,
      operation: "authentication",
      context,
    }),
    PasskeyTestSelectorBindingError,
  );
  assert.equal(invalidFixture.calls.length, 0);
});

test("resolver and adapter failures use one deterministic fail-closed class", async () => {
  const resolverFailure = createPasskeyTestTransactionSelectorCapability(
    async () => {
      throw new Error("synthetic resolver detail");
    },
  );
  await assert.rejects(
    resolverFailure.bind({
      adapter: adapterFixture().adapter,
      operation: "authentication",
      context,
    }),
    PasskeyTestSelectorBindingError,
  );

  const adapterFailure = createPasskeyTestTransactionSelectorCapability(
    async () => selector(),
  );
  await assert.rejects(
    adapterFailure.bind({
      adapter: adapterFixture({ fail: true }).adapter,
      operation: "authentication",
      context,
    }),
    PasskeyTestSelectorBindingError,
  );
  await assert.rejects(
    adapterFailure.bind({
      adapter: adapterFixture({ mismatch: true }).adapter,
      operation: "authentication",
      context,
    }),
    PasskeyTestSelectorBindingError,
  );
});

test("each bind resolves fresh state and never reuses another adapter", async () => {
  let attempt = 0;
  const capability = createPasskeyTestTransactionSelectorCapability(async () =>
    selector({ attemptId: `attempt-${++attempt}` }),
  );
  const first = adapterFixture();
  const second = adapterFixture();
  await capability.bind({
    adapter: first.adapter,
    operation: "authentication",
    context,
  });
  await capability.bind({
    adapter: second.adapter,
    operation: "authentication",
    context,
  });
  assert.equal(first.calls.length, 1);
  assert.equal(second.calls.length, 1);
  assert.equal(
    JSON.parse(first.calls[0].data.payload).attemptId,
    "attempt-1",
  );
  assert.equal(
    JSON.parse(second.calls[0].data.payload).attemptId,
    "attempt-2",
  );
});

test("source contains no pool, raw query, transaction, global selector, or public input seam", () => {
  assert.doesNotMatch(source, /\bPool\b|PoolClient|\.query\s*\(|runWithTransaction/);
  assert.doesNotMatch(source, /i6_fault\.control|globalThis|process\.env|headers|request\.body/);
  assert.match(source, /adapter\.create/);
  assert.match(source, /disableMigration: true/);
});
