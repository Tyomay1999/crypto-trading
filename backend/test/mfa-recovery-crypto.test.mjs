import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  generateRecoveryCodes,
  normalizeRecoveryCode,
  recoveryDigest,
  requireRecoveryPepper,
} from "../dist/auth/recovery-codes.js";

const pepper = "recovery-only-test-pepper-0123456789";
test("recovery codes use CSPRNG, 160 unbiased bits, ten unique fixed ASCII codes", () => {
  const codes = generateRecoveryCodes();
  assert.equal(codes.length, 10);
  assert.equal(new Set([...codes, ...generateRecoveryCodes()]).size, 20);
  for (const code of codes) {
    assert.match(code, /^[2-9A-HJ-NP-Z]{4}(?:-[2-9A-HJ-NP-Z]{4}){7}$/);
    assert.equal(normalizeRecoveryCode(code), code);
    assert.equal(normalizeRecoveryCode(code.toLowerCase()), null);
    assert.equal(normalizeRecoveryCode("AbCd" + code.slice(4)), null);
  }
  const source = readFileSync("src/auth/recovery-codes.ts", "utf8");
  assert.match(source, /randomBytes\(32\)/);
  assert.match(source, /byte & 31/);
  assert.doesNotMatch(source, /Math\.random/);
});
test("normalization rejects Unicode, whitespace, missing grouping and punctuation", () => {
  const code = generateRecoveryCodes()[0];
  for (const invalid of [
    null,
    42,
    {},
    code + "\n",
    " " + code,
    code.replaceAll("-", ""),
    code.replace("-", " "),
    code.replace("-", "—"),
    "Ａ" + code.slice(1),
    "0" + code.slice(1),
    "I" + code.slice(1),
    code + "!",
    code.slice(1),
  ]) {
    assert.equal(normalizeRecoveryCode(invalid), null);
  }
});
test("pepper validation counts UTF-8 bytes and compares encoded bytes", () => {
  const a = "a".repeat(32),
    b = "b".repeat(32);
  for (const bad of [undefined, "a".repeat(31), "é".repeat(15), a, b])
    assert.throws(() => requireRecoveryPepper(bad, a, b));
  assert.equal(requireRecoveryPepper("é".repeat(16), a, b), "é".repeat(16));
  assert.throws(() =>
    requireRecoveryPepper(
      "x".repeat(32) + "\ud800",
      "x".repeat(32) + "\ud801",
      b,
    ),
  );
});
test("HMAC-SHA-256 uses framed domain, user and generation binding with one BYTEA codec", () => {
  const code = "2345-6789-ABCD-EFGH-JKLM-NPQR-STUV-WXYZ";
  const expected = createHmac("sha256", Buffer.from(pepper, "utf8"))
    .update(
      '["delta:recovery-code:v1","user","generation","2345-6789-ABCD-EFGH-JKLM-NPQR-STUV-WXYZ"]',
    )
    .digest("hex");
  const digest = recoveryDigest(pepper, "user", "generation", code);
  assert.equal(digest, "\\x" + expected);
  assert.equal(Buffer.from(digest.slice(2), "hex").length, 32);
  assert.notEqual(digest, recoveryDigest(pepper, "other", "generation", code));
  assert.notEqual(digest, recoveryDigest(pepper, "user", "other", code));
  assert.notEqual(
    digest,
    recoveryDigest(pepper + "x", "user", "generation", code),
  );
  assert.notEqual(
    recoveryDigest(pepper, "a\0b", "c", code),
    recoveryDigest(pepper, "a", "b\0c", code),
  );
  assert.throws(() =>
    recoveryDigest(pepper, "user", "generation", "malformed"),
  );
});
