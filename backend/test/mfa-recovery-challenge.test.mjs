import assert from "node:assert/strict";
import test from "node:test";

import { completeRecoveryChallengeTransaction } from "../dist/auth/recovery-challenge.js";
import { enforceRecoveryChallengeOutcome } from "../dist/auth/recovery-code-plugin.js";

const pepper = "recovery-challenge-test-pepper-0123456789";

const code = "2345-6789-ABCD-EFGH-JKLM-NPQR-STUV-WXYZ";

const challenge = "2fa-abcdefghijklmnopqrst";

const expiresAt = new Date("2100-01-01T00:00:00.000Z");

test("challenge outcomes map invalid credentials to 401 and active locks to 429", () => {
  assert.doesNotThrow(() => enforceRecoveryChallengeOutcome("verified"));
  assert.throws(
    () => enforceRecoveryChallengeOutcome("rejected"),
    (error) =>
      error.statusCode === 401 &&
      error.body.code === "RECOVERY_CHALLENGE_REJECTED",
  );
  assert.throws(
    () => enforceRecoveryChallengeOutcome("account_locked"),
    (error) =>
      error.statusCode === 429 && error.body.code === "RECOVERY_ACCOUNT_LOCKED",
  );
});

function challengeHarness(overrides = {}) {
  const initial = {
    attempt: Object.hasOwn(overrides, "attempt") ? overrides.attempt : 0,
    challengeUser: overrides.challengeUser ?? "user-a",
    recoverySet: Object.hasOwn(overrides, "recoverySet")
      ? overrides.recoverySet
      : true,
    codeAvailable: overrides.codeAvailable ?? true,
    factorFailures: overrides.factorFailures ?? 0,
    lockedUntil: overrides.lockedUntil ?? null,
    markerFailure: overrides.markerFailure ?? false,
    storageFailure: overrides.storageFailure ?? false,
    staleUser: overrides.staleUser ?? null,
    sessions: 0,
    markers: 0,
  };

  let state = structuredClone(initial);

  const events = [];

  const transactionAdapter = {
    async findOne({ model }) {
      events.push(`find:${model}`);

      if (model === "recoveryCodeSet" && state.recoverySet) {
        return {
          id: "set-a",
          userId: "user-a",
          generation: "11111111-1111-4111-8111-111111111111",
          createdAt: new Date(),
          updatedAt: new Date(),
        };
      }

      return null;
    },

    async incrementOne({ model, increment }) {
      events.push(`increment:${model}`);

      if (model === "user") {
        return {
          id: "user-a",
          twoFactorEnabled: true,
        };
      }

      if (model === "twoFactor") {
        if (increment && "failedVerificationCount" in increment) {
          state.factorFailures += 1;

          return {
            failedVerificationCount: state.factorFailures,
          };
        }

        return {
          id: "factor-a",
          userId: "user-a",
          secret: "encrypted-secret",
          verified: true,
          failedVerificationCount: state.factorFailures,
          lockedUntil: state.lockedUntil,
        };
      }

      if (model === "recoveryCodeSet") {
        return {
          id: "set-a",
          userId: "user-a",
          generation: "11111111-1111-4111-8111-111111111111",
          createdAt: new Date(),
          updatedAt: new Date(),
        };
      }

      return null;
    },

    async consumeOne({ model }) {
      events.push(`consume:${model}`);

      if (state.storageFailure) {
        throw new Error("synthetic storage failure");
      }

      if (model === "recoveryCode" && state.codeAvailable) {
        state.codeAvailable = false;
        return { id: "code-a" };
      }

      return null;
    },

    async update({ model, update }) {
      events.push(`update:${model}`);

      if (model === "twoFactor" && update.failedVerificationCount === 0) {
        state.factorFailures = 0;
        state.lockedUntil = null;
      } else if (model === "twoFactor" && update.lockedUntil) {
        state.lockedUntil = update.lockedUntil;
      }

      return {};
    },

    async create({ model }) {
      events.push(`create:${model}`);

      if (model === "recoverySessionMarker") {
        if (state.markerFailure) {
          return null;
        }

        state.markers += 1;
      }

      return { id: "created" };
    },
  };

  const adapter = {
    id: "challenge-test",

    async transaction(callback) {
      const snapshot = structuredClone(state);

      events.push("transaction:begin");

      try {
        const result = await callback(transactionAdapter);

        events.push("transaction:commit");
        return result;
      } catch (error) {
        state = snapshot;
        events.push("transaction:rollback");
        throw error;
      }
    },
  };

  let pendingReads = 0;

  const internal = {
    async consumeVerificationValue(identifier) {
      events.push(`verification:consume:${identifier}`);

      if (identifier === `2fa-attempts-${challenge}`) {
        if (state.attempt === null) {
          return null;
        }

        const value = state.attempt;
        state.attempt = null;

        return {
          value: String(value),
          expiresAt,
        };
      }

      if (identifier === challenge) {
        if (state.challengeUser === null) {
          return null;
        }

        const value = state.challengeUser;
        state.challengeUser = null;

        return {
          value,
          expiresAt,
        };
      }

      return null;
    },

    async findVerificationValue(identifier) {
      events.push(`verification:find:${identifier}`);

      if (identifier !== challenge || state.challengeUser === null) {
        return null;
      }

      pendingReads += 1;

      return {
        value:
          pendingReads > 1 && state.staleUser
            ? state.staleUser
            : state.challengeUser,
        expiresAt,
      };
    },

    async createVerificationValue(value) {
      events.push(`verification:rearm:${value.value}`);

      state.attempt = Number(value.value);
      return { id: "attempt-successor" };
    },

    async createSession() {
      events.push("session:create");
      state.sessions += 1;

      return {
        id: `session-${state.sessions}`,
        userId: "user-a",
        token: "internal-test-token",
        expiresAt,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    },
  };

  const run = () =>
    completeRecoveryChallengeTransaction(
      adapter,
      internal,
      pepper,
      code,
      challenge,
      false,
    );

  return {
    events,
    get state() {
      return state;
    },
    setMarkerFailure(value) {
      state.markerFailure = value;
    },
    run,
  };
}

test("committed success consumes attempt, challenge and code and permits no second session", async () => {
  const harness = challengeHarness();

  assert.ok(await harness.run());
  assert.equal(harness.state.sessions, 1);
  assert.equal(harness.state.markers, 1);
  assert.equal(harness.state.attempt, null);
  assert.equal(harness.state.challengeUser, null);
  assert.equal(harness.state.codeAvailable, false);

  assert.equal(await harness.run(), null);
  assert.equal(harness.state.sessions, 1);
  assert.equal(harness.state.markers, 1);
});

test("committed credential rejection rearms only the incremented shared budget", async () => {
  const harness = challengeHarness({
    attempt: 1,
    codeAvailable: false,
  });

  assert.equal(await harness.run(), null);
  assert.equal(harness.state.attempt, 2);
  assert.equal(harness.state.factorFailures, 1);
  assert.equal(harness.state.sessions, 0);
  assert.ok(harness.events.includes("verification:rearm:2"));

  assert.equal(await harness.run(), null);
  assert.equal(harness.state.attempt, 3);
  assert.equal(harness.state.factorFailures, 2);
  assert.equal(harness.state.sessions, 0);
  assert.ok(harness.events.includes("verification:rearm:3"));
});

test("infrastructure rollback restores attempt, challenge, code and session eligibility", async () => {
  const harness = challengeHarness({
    markerFailure: true,
  });

  await assert.rejects(harness.run(), /provenance insertion failed/);

  assert.equal(harness.state.attempt, 0);
  assert.equal(harness.state.challengeUser, "user-a");
  assert.equal(harness.state.codeAvailable, true);
  assert.equal(harness.state.sessions, 0);
  assert.equal(harness.state.markers, 0);
  assert.ok(harness.events.includes("transaction:rollback"));

  harness.setMarkerFailure(false);

  assert.ok(await harness.run());
  assert.equal(harness.state.sessions, 1);
  assert.equal(harness.state.markers, 1);
});

test("post-lock challenge revalidation prevents stale user decisions", async () => {
  const harness = challengeHarness({
    staleUser: "user-b",
  });

  assert.equal(await harness.run(), null);
  assert.equal(harness.state.sessions, 0);
  assert.equal(harness.state.codeAvailable, true);

  const readIndexes = harness.events.flatMap((value, index) =>
    value === `verification:find:${challenge}` ? [index] : [],
  );
  const serializationIndex = harness.events.indexOf(
    "increment:recoveryCodeSet",
  );

  assert.equal(readIndexes.length, 2);
  assert.ok(serializationIndex >= 0);
  assert.ok(readIndexes[1] > serializationIndex);
  assert.equal(harness.events.includes("session:create"), false);
});

test("fifth committed failure locks the account and preserves the shared successor budget", async () => {
  const harness = challengeHarness({
    attempt: 4,
    codeAvailable: false,
    factorFailures: 9,
  });

  assert.equal(await harness.run(), null);
  assert.equal(harness.state.attempt, 5);
  assert.equal(harness.state.factorFailures, 10);
  assert.ok(harness.state.lockedUntil instanceof Date);
  assert.equal(harness.state.sessions, 0);
});

test("an active account lock is distinct, commits before return and preserves the shared attempt", async () => {
  const harness = challengeHarness({
    attempt: 2,
    factorFailures: 10,
    lockedUntil: new Date("2100-01-01T00:00:00.000Z"),
  });

  assert.equal(await harness.run(), "account_locked");
  assert.equal(harness.state.attempt, 2);
  assert.equal(harness.state.factorFailures, 10);
  assert.equal(harness.state.codeAvailable, true);
  assert.equal(harness.state.sessions, 0);
  assert.ok(harness.events.includes("verification:rearm:2"));
  assert.equal(harness.events.at(-1), "transaction:commit");
});

test("an absent recovery set commits the same failure accounting as a wrong code", async () => {
  const harness = challengeHarness({
    attempt: 0,
    recoverySet: false,
  });

  assert.equal(await harness.run(), null);
  assert.equal(harness.state.attempt, 1);
  assert.equal(harness.state.factorFailures, 1);
  assert.equal(harness.state.codeAvailable, true);
  assert.equal(harness.state.sessions, 0);
});

test("missing or exhausted attempt state never reaches recovery consumption", async () => {
  for (const attempt of [null, 5]) {
    const harness = challengeHarness({
      attempt,
    });

    assert.equal(await harness.run(), null);
    assert.equal(harness.state.sessions, 0);
    assert.equal(harness.state.codeAvailable, true);
  }
});
