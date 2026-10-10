import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync("src/auth/passkey-counter.ts", "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: "passkey-counter.ts",
}).outputText;
const counter = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`
);

test("DB int8 text converts to the exact WebAuthn uint32 domain", () => {
  for (const [stored, expected] of [
    ["0", 0],
    ["1", 1],
    ["2147483647", 2_147_483_647],
    ["2147483648", 2_147_483_648],
    ["4294967295", 4_294_967_295],
  ]) {
    assert.equal(counter.passkeyCounterFromDatabase(stored), expected);
  }

  assert.equal(counter.WEBAUTHN_COUNTER_MAX, 4_294_967_295);
});

test("DB counter parsing rejects noncanonical or out-of-range input", () => {
  for (const invalid of [
    "",
    " ",
    "00",
    "01",
    "-1",
    "+1",
    "1.0",
    "1e3",
    "4294967296",
    "counter",
    0,
    1n,
    null,
    undefined,
  ]) {
    assert.throws(
      () => counter.passkeyCounterFromDatabase(invalid),
      /Invalid WebAuthn signature counter/,
    );
  }
});

test("domain counters encode to canonical PostgreSQL BIGINT text", () => {
  for (const [value, expected] of [
    [0, "0"],
    [1, "1"],
    [2_147_483_648, "2147483648"],
    [4_294_967_295, "4294967295"],
  ]) {
    assert.equal(counter.passkeyCounterToDatabase(value), expected);
  }
});

test("domain conversion permits no implicit coercion", () => {
  for (const invalid of [
    -1,
    4_294_967_296,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    "1",
    1n,
    null,
    undefined,
  ]) {
    assert.throws(
      () => counter.passkeyCounterToDatabase(invalid),
      /Invalid WebAuthn signature counter/,
    );
  }

  assert.match(source, /typeof value !== "number"/);
  assert.doesNotMatch(source, /parseInt|parseFloat|BigInt\.asUintN|>>>|>>|<<|\|\s*0/);
});
