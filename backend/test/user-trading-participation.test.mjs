import assert from "node:assert/strict";
import test from "node:test";

const {
  PostgresParticipationRepository,
  UserSignalParticipationService,
} = await import("../dist/user-trading/participation/index.js");

function participation(overrides = {}) {
  return {
    participationId: "p-1",
    userId: "user-a",
    signalId: "signal-a",
    status: "FOLLOWING",
    subscribedAt: "2026-10-11T15:00:00.000Z",
    unsubscribedAt: null,
    createdAt: "2026-10-11T15:00:00.000Z",
    updatedAt: "2026-10-11T15:00:00.000Z",
    ...overrides,
  };
}

function harness(overrides = {}) {
  const calls = [];
  const state = {
    signalExists: true,
    live: null,
    owned: null,
    createResult: participation(),
    transitionResult: participation({
      status: "CANCELLED",
      unsubscribedAt: "2026-10-11T16:00:00.000Z",
      updatedAt: "2026-10-11T16:00:00.000Z",
    }),
    ...overrides,
  };

  const repository = {
    async signalExists(signalId) {
      calls.push(["signalExists", signalId]);
      return state.signalExists;
    },
    async findLiveByUserSignal(userId, signalId) {
      calls.push(["findLiveByUserSignal", userId, signalId]);
      return state.live;
    },
    async findOwnedById(userId, participationId) {
      calls.push(["findOwnedById", userId, participationId]);
      return state.owned;
    },
    async tryCreateFollowing(input) {
      calls.push(["tryCreateFollowing", input]);
      return state.createResult;
    },
    async transitionOwned(...args) {
      calls.push(["transitionOwned", ...args]);
      return state.transitionResult;
    },
  };

  let nextId = 1;
  const service = new UserSignalParticipationService({
    repository,
    clock: {
      nowIso() {
        return "2026-10-11T16:00:00.000Z";
      },
    },
    idFactory: {
      createParticipationId() {
        return `generated-${nextId++}`;
      },
    },
  });

  return { calls, repository, service, state };
}

test("follow creates one FOLLOWING participation for an existing global signal", async () => {
  const { service, calls } = harness({
    createResult: participation({
      participationId: "generated-1",
      subscribedAt: "2026-10-11T16:00:00.000Z",
      createdAt: "2026-10-11T16:00:00.000Z",
      updatedAt: "2026-10-11T16:00:00.000Z",
    }),
  });

  const result = await service.followSignal("user-a", "signal-a");

  assert.equal(result.kind, "CREATED");
  assert.equal(result.participation.userId, "user-a");
  assert.equal(result.participation.signalId, "signal-a");
  assert.equal(result.participation.status, "FOLLOWING");

  const create = calls.find(([name]) => name === "tryCreateFollowing");
  assert.ok(create);
  assert.equal(create[1].participationId, "generated-1");
  assert.equal(create[1].userId, "user-a");
  assert.equal(create[1].signalId, "signal-a");
});

test("repeat follow is idempotent and does not create a second live participation", async () => {
  const existing = participation();
  const { service, calls } = harness({ live: existing });

  const result = await service.followSignal("user-a", "signal-a");

  assert.equal(result.kind, "EXISTING");
  assert.deepEqual(result.participation, existing);
  assert.equal(
    calls.some(([name]) => name === "tryCreateFollowing"),
    false,
  );
  assert.equal(
    calls.some(([name]) => name === "signalExists"),
    false,
  );
});

test("follow rejects an unknown global signal without inserting user state", async () => {
  const { service, calls } = harness({
    signalExists: false,
    createResult: null,
  });

  const result = await service.followSignal("user-a", "missing-signal");

  assert.deepEqual(result, { kind: "SIGNAL_NOT_FOUND" });
  assert.equal(
    calls.some(([name]) => name === "tryCreateFollowing"),
    false,
  );
});

test("concurrent follow loser returns the durable winning participation", async () => {
  const winner = participation({
    participationId: "winner",
    subscribedAt: "2026-10-11T16:00:00.000Z",
    createdAt: "2026-10-11T16:00:00.000Z",
    updatedAt: "2026-10-11T16:00:00.000Z",
  });

  let reads = 0;
  const h = harness({
    createResult: null,
  });
  h.repository.findLiveByUserSignal = async (userId, signalId) => {
    h.calls.push(["findLiveByUserSignal", userId, signalId]);
    reads += 1;
    return reads === 1 ? null : winner;
  };

  const result = await h.service.followSignal("user-a", "signal-a");

  assert.equal(result.kind, "EXISTING");
  assert.equal(result.participation.participationId, "winner");
});

test("unfollow cancels FOLLOWING participation and records unsubscribe time", async () => {
  const current = participation();
  const cancelled = participation({
    status: "CANCELLED",
    unsubscribedAt: "2026-10-11T16:00:00.000Z",
    updatedAt: "2026-10-11T16:00:00.000Z",
  });

  const { service, calls } = harness({
    owned: current,
    transitionResult: cancelled,
  });

  const result = await service.unfollowParticipation("user-a", "p-1");

  assert.equal(result.kind, "CANCELLED");
  assert.equal(result.participation.status, "CANCELLED");
  assert.equal(
    result.participation.unsubscribedAt,
    "2026-10-11T16:00:00.000Z",
  );

  const transition = calls.find(([name]) => name === "transitionOwned");
  assert.ok(transition);
  assert.deepEqual(transition[3], ["FOLLOWING", "PLANNED"]);
  assert.equal(transition[4], "CANCELLED");
});

test("ACTIVE participation cannot be unfollowed into cancellation", async () => {
  const active = participation({ status: "ACTIVE" });
  const { service, calls } = harness({ owned: active });

  const result = await service.unfollowParticipation("user-a", "p-1");

  assert.equal(result.kind, "ACTIVE_CONFLICT");
  assert.equal(
    calls.some(([name]) => name === "transitionOwned"),
    false,
  );
});

test("terminal participation remains terminal and can later coexist with a new history row", async () => {
  const completed = participation({ status: "COMPLETED" });
  const { service, calls } = harness({ owned: completed });

  const result = await service.unfollowParticipation("user-a", "p-1");

  assert.equal(result.kind, "ALREADY_TERMINAL");
  assert.equal(result.participation.status, "COMPLETED");
  assert.equal(
    calls.some(([name]) => name === "transitionOwned"),
    false,
  );
});

test("missing and foreign participation collapse to the same NOT_FOUND result", async () => {
  const { service } = harness({ owned: null });

  assert.deepEqual(
    await service.unfollowParticipation("user-a", "foreign-or-missing"),
    { kind: "NOT_FOUND" },
  );
});

test("service fails closed if repository leaks another user's participation", async () => {
  const leaked = participation({ userId: "user-b" });
  const { service } = harness({ live: leaked });

  await assert.rejects(
    () => service.followSignal("user-a", "signal-a"),
    /ownership boundary/u,
  );
});

test("opaque identity validation rejects whitespace and control characters before storage", async () => {
  const { service, calls } = harness();

  await assert.rejects(
    () => service.followSignal(" user-a", "signal-a"),
    /userId/u,
  );
  await assert.rejects(
    () => service.followSignal("user-a", "signal-\nA"),
    /signalId/u,
  );

  assert.equal(calls.length, 0);
});

test("Postgres repository scopes ownership in SQL and parameterizes every user-controlled value", async () => {
  const calls = [];
  const db = {
    async query(text, values = []) {
      calls.push({ text, values });
      return { rows: [] };
    },
  };

  const repo = new PostgresParticipationRepository(db);

  await repo.findOwnedById("user-A' OR 1=1 --", "p-$2");
  await repo.findLiveByUserSignal("user-A", "signal-$1");
  await repo.tryCreateFollowing({
    participationId: "p-1",
    userId: "user-A",
    signalId: "signal-A",
    subscribedAt: "2026-10-11T16:00:00.000Z",
  });
  await repo.transitionOwned(
    "user-A",
    "p-1",
    ["FOLLOWING", "PLANNED"],
    "CANCELLED",
    "2026-10-11T16:00:00.000Z",
    "2026-10-11T16:00:00.000Z",
  );

  assert.equal(calls.length, 4);

  for (const call of calls) {
    assert.doesNotMatch(call.text, /user-A|signal-A|p-1|OR 1=1/u);
  }

  assert.match(calls[0].text, /WHERE user_id = \$1[\s\S]*participation_id = \$2/u);
  assert.match(calls[1].text, /WHERE user_id = \$1[\s\S]*signal_id = \$2/u);
  assert.match(calls[2].text, /ON CONFLICT DO NOTHING/u);
  assert.match(calls[3].text, /user_id = \$1[\s\S]*participation_id = \$2[\s\S]*status = ANY\(\$6::text\[\]\)/u);
});

test("participation source has no auth/security implementation dependency", async () => {
  const { readFileSync } = await import("node:fs");

  for (const file of [
    "src/user-trading/participation/types.ts",
    "src/user-trading/participation/repository.ts",
    "src/user-trading/participation/service.ts",
    "src/user-trading/participation/postgres-repository.ts",
    "src/user-trading/participation/index.ts",
  ]) {
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(
      source,
      /from\s+["'][^"']*(?:\/auth\/|\/security\/|require-session|better-auth)/iu,
      `${file} must remain independent of frozen security implementation`,
    );
  }
});
