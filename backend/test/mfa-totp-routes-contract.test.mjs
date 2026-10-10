import assert from "node:assert/strict";
import {
  readFile,
} from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root =
  process.cwd();

async function source(
  ...parts
) {
  return readFile(
    path.join(
      root,
      ...parts,
    ),
    "utf8",
  );
}

test(
  "Delta exposes controlled enrollment, login challenge and disable TOTP routes",
  async () => {
    const value =
      await source(
        "src",
        "routes",
        "mfa-totp.routes.ts",
      );

    for (
      const route
      of [
        '"/enroll"',
        '"/enroll/verify"',
        '"/challenge/verify"',
        '"/disable"',
      ]
    ) {
      assert.ok(
        value.includes(route),
      );
    }
  },
);

test(
  "all authenticated TOTP security mutations require trusted origin",
  async () => {
    const value =
      await source(
        "src",
        "routes",
        "mfa-totp.routes.ts",
      );

    assert.match(
      value,
      /"\/enroll",[\s\S]{0,140}requireTrustedOrigin,[\s\S]{0,140}requireSession/,
    );

    assert.match(
      value,
      /"\/enroll\/verify",[\s\S]{0,140}requireTrustedOrigin,[\s\S]{0,140}requireSession/,
    );

    assert.match(
      value,
      /"\/disable",[\s\S]{0,140}requireTrustedOrigin,[\s\S]{0,140}requireSession/,
    );
  },
);

test(
  "login challenge remains trusted-origin protected and unauthenticated",
  async () => {
    const value =
      await source(
        "src",
        "routes",
        "mfa-totp.routes.ts",
      );

    assert.match(
      value,
      /"\/challenge\/verify",[\s\S]{0,140}requireTrustedOrigin/,
    );

    assert.match(
      value,
      /MFA_CHALLENGE_REQUIRES_UNAUTHENTICATED_STATE/,
    );
  },
);

test(
  "enrollment verification uses durable replay finalization before cookie release",
  async () => {
    const value =
      await source(
        "src",
        "routes",
        "mfa-totp.routes.ts",
      );

    const start =
      value.indexOf(
        '"/enroll/verify"',
      );

    const finalize =
      value.indexOf(
        "finalizeTotpEnrollmentVerification(",
        start,
      );

    const cookie =
      value.indexOf(
        "getBetterAuthSetCookies(",
        finalize,
      );

    assert.ok(start >= 0);
    assert.ok(finalize > start);
    assert.ok(cookie > finalize);
  },
);

test(
  "login challenge keeps transactional replay finalization",
  async () => {
    const value =
      await source(
        "src",
        "routes",
        "mfa-totp.routes.ts",
      );

    assert.match(
      value,
      /finalizeTotpLoginChallenge/,
    );

    assert.match(
      value,
      /trustDevice:\s*(?:\n\s*)?false/,
    );
  },
);

test(
  "TOTP replay uses dedicated replay pepper instead of Better Auth secret",
  async () => {
    const router =
      await source(
        "src",
        "routes",
        "mfa-totp.routes.ts",
      );

    const server =
      await source(
        "src",
        "server.ts",
      );

    const config =
      await source(
        "src",
        "auth",
        "config.ts",
      );

    assert.match(
      router,
      /replayPepper/,
    );

    assert.doesNotMatch(
      router,
      /replayMasterSecret/,
    );

    assert.match(
      server,
      /replayPepper:\s*(?:\n\s*)?authEnv\.replayPepper/,
    );

    assert.match(
      config,
      /TOTP_REPLAY_PEPPER/,
    );
  },
);

test(
  "TOTP disable performs password proof before atomic downgrade",
  async () => {
    const value =
      await source(
        "src",
        "routes",
        "mfa-totp.routes.ts",
      );

    const disable =
      value.indexOf(
        '"/disable"',
      );

    const proof =
      value.indexOf(
        ".getTOTPURI({",
        disable,
      );

    const downgrade =
      value.indexOf(
        "disableTotpAndRevokeAllSessions(",
        disable,
      );

    assert.ok(disable >= 0);
    assert.ok(proof > disable);
    assert.ok(downgrade > proof);
  },
);

test(
  "TOTP disable ends in browser sign-out and exposes no replacement session",
  async () => {
    const value =
      await source(
        "src",
        "routes",
        "mfa-totp.routes.ts",
      );

    const disable =
      value.indexOf(
        '"/disable"',
      );

    const signOut =
      value.indexOf(
        ".signOut({",
        disable,
      );

    const status204 =
      value.indexOf(
        "status(204)",
        signOut,
      );

    const nextRoute =
      value.indexOf(
        '"/challenge/verify"',
        disable,
      );

    assert.ok(
      disable >= 0,
    );

    assert.ok(
      signOut > disable,
    );

    assert.ok(
      status204 > signOut,
    );

    assert.ok(
      nextRoute > status204,
    );
  },
);

test(
  "all controlled TOTP responses remain non-cacheable",
  async () => {
    const value =
      await source(
        "src",
        "routes",
        "mfa-totp.routes.ts",
      );

    assert.match(
      value,
      /"Cache-Control",[\s\S]{0,40}"no-store"/,
    );

    assert.match(
      value,
      /"Pragma",[\s\S]{0,40}"no-cache"/,
    );
  },
);

test(
  "public API never exposes Better Auth backup codes or bearer token",
  async () => {
    const value =
      await source(
        "src",
        "routes",
        "mfa-totp.routes.ts",
      );

    assert.doesNotMatch(
      value,
      /\.json\(\{[\s\S]{0,100}backupCodes/,
    );

    assert.doesNotMatch(
      value,
      /\.json\(\{[\s\S]{0,100}sessionToken/,
    );
  },
);


test(
  "initial TOTP enrollment follows Better Auth rotation Set-Cookie instead of stale JSON token",
  async () => {
    const value =
      await source(
        "src",
        "routes",
        "mfa-totp.routes.ts",
      );

    const storage =
      await source(
        "src",
        "storage",
        "totp-replay.ts",
      );

    const betterAuthTotp =
      await source(
        "node_modules",
        "better-auth",
        "dist",
        "plugins",
        "two-factor",
        "totp",
        "index.mjs",
      );

    const betterAuthVerify =
      await source(
        "node_modules",
        "better-auth",
        "dist",
        "plugins",
        "two-factor",
        "verify-two-factor.mjs",
      );

    /*
     * Pin the installed Better Auth behavior that
     * caused the runtime defect.
     */
    assert.match(
      betterAuthTotp,
      /createSession\(user\.id,\s*false,\s*activeSession\)/,
    );

    assert.match(
      betterAuthTotp,
      /deleteSession\(activeSession\.token\)/,
    );

    assert.match(
      betterAuthVerify,
      /token:\s*session\.session\.token/,
    );

    const start =
      value.indexOf(
        '"/enroll/verify"',
      );

    const end =
      value.indexOf(
        '"/replace/start"',
        start,
      );

    assert.notEqual(
      start,
      -1,
    );

    assert.notEqual(
      end,
      -1,
    );

    const enrollment =
      value.slice(
        start,
        end,
      );

    assert.match(
      value,
      /async function resolveRotatedEnrollmentSession\(/,
    );

    assert.match(
      value,
      /buildBetterAuthCookieHeader\(/,
    );

    assert.match(
      enrollment,
      /const verificationCookies\s*=/,
    );

    assert.match(
      enrollment,
      /resolveRotatedEnrollmentSession\(/,
    );

    assert.match(
      enrollment,
      /rotatedSession\.sessionId/,
    );

    assert.match(
      enrollment,
      /deleteTotpEnrollmentSession\(/,
    );

    assert.doesNotMatch(
      enrollment,
      /parseVerificationIdentity\(/,
    );

    assert.doesNotMatch(
      enrollment,
      /identity\.sessionToken/,
    );

    /*
     * Cookie release must remain after the durable
     * replay finalization call.
     */
    assert.ok(
      enrollment.indexOf(
        "finalizeTotpEnrollmentVerification(",
      ) <
      enrollment.lastIndexOf(
        "appendCookies(",
      ),
    );

    assert.match(
      storage,
      /lockRotatedEnrollmentSession[\s\S]*WHERE "id"\s*=\s*\$1/,
    );

    assert.match(
      storage,
      /finalizeTotpEnrollmentVerification[\s\S]*AND "id"\s*<>\s*\$2/,
    );

    /*
     * Login MFA remains on the existing token
     * contract because Better Auth creates the
     * login session after challenge verification.
     */
    const challengeStart =
      value.indexOf(
        '"/challenge/verify"',
      );

    const challenge =
      value.slice(
        challengeStart,
      );

    assert.match(
      challenge,
      /parseVerificationIdentity\(/,
    );

    assert.match(
      challenge,
      /identity\.sessionToken/,
    );
  },
);
