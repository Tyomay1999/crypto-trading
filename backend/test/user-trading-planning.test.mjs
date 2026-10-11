import assert from "node:assert/strict";
import test from "node:test";

const {
  DeterministicExchangeAccountSnapshotProvider,
  PostgresTradePlanningRepository,
  UserTradePlanningService,
  calculateTradeRecommendation,
  parseExactDecimal,
  multiplyExact,
  formatPositiveDecimal,
} = await import("../dist/user-trading/planning/index.js");

function account(overrides = {}) {
  return {
    providerKind: "FAKE_DETERMINISTIC",
    exchange: "binance",
    accountReference: "demo-main",
    currency: "USDT",
    availableBalance: "5000",
    equity: "5200",
    observedAt: "2026-10-11T16:00:00.000Z",
    ...overrides,
  };
}

test("exact decimal arithmetic never uses JS Number for authoritative multiplication", () => {
  const a = parseExactDecimal("0.1");
  const b = parseExactDecimal("0.2");
  const product = multiplyExact(a, b);
  assert.equal(formatPositiveDecimal(product, 8, "DOWN"), "0.02");
});

test("risk engine derives $500 recommendation from $5000 balance at 1% risk and 10% stop distance", () => {
  const result = calculateTradeRecommendation({
    account: account(),
    signal: {
      signalId: "signal-a",
      direction: "LONG",
      entryPrice: "100",
      stopPrice: "90",
    },
    policy: {
      targetRiskFraction: "0.01",
      reserveFraction: "0.2",
      maxLeverage: "10",
      marginMode: "ISOLATED",
    },
  });

  assert.equal(result.targetRiskAmount, "50");
  assert.equal(result.stopDistanceFraction, "0.1");
  assert.equal(result.suggestedPositionNotional, "500");
  assert.equal(result.suggestedLeverage, "1");
  assert.equal(result.suggestedRequiredMargin, "500");
  assert.equal(result.selectedPositionNotional, "500");
  assert.equal(result.selectedRiskAmount, "50");
  assert.equal(result.selectedRiskFraction, "0.01");
  assert.equal(result.valueSource, "SYSTEM_SUGGESTED");
});

test("mandatory override scenario uses user-selected $350 rather than suggested $500", () => {
  const result = calculateTradeRecommendation({
    account: account(),
    signal: {
      signalId: "signal-a",
      direction: "LONG",
      entryPrice: "100",
      stopPrice: "90",
    },
    policy: {
      targetRiskFraction: "0.01",
      reserveFraction: "0.2",
      maxLeverage: "10",
      marginMode: "ISOLATED",
    },
    override: {
      selectedPositionNotional: "350",
      selectedLeverage: "2",
    },
  });

  assert.equal(result.suggestedPositionNotional, "500");
  assert.equal(result.selectedPositionNotional, "350");
  assert.equal(result.selectedLeverage, "2");
  assert.equal(result.selectedRequiredMargin, "175");
  assert.equal(result.selectedRiskAmount, "35");
  assert.equal(result.selectedRiskFraction, "0.007");
  assert.equal(result.valueSource, "USER_OVERRIDE");
});

test("suggested leverage is the minimum integer leverage needed to fit policy-usable margin", () => {
  const result = calculateTradeRecommendation({
    account: account(),
    signal: {
      signalId: "signal-a",
      direction: "LONG",
      entryPrice: "100",
      stopPrice: "99.5",
    },
    policy: {
      targetRiskFraction: "0.01",
      reserveFraction: "0.2",
      maxLeverage: "10",
      marginMode: "ISOLATED",
    },
  });

  assert.equal(result.targetRiskAmount, "50");
  assert.equal(result.riskBasedNotional, "10000");
  assert.equal(result.usableMargin, "4000");
  assert.equal(result.suggestedPositionNotional, "10000");
  assert.equal(result.suggestedLeverage, "3");
  assert.equal(result.suggestedRequiredMargin, "3333.33333334");
});

test("leverage does not alter stop-loss cash risk for a fixed notional", () => {
  const common = {
    account: account(),
    signal: {
      signalId: "signal-a",
      direction: "LONG",
      entryPrice: "100",
      stopPrice: "90",
    },
    policy: {
      targetRiskFraction: "0.01",
      reserveFraction: "0.2",
      maxLeverage: "10",
      marginMode: "ISOLATED",
    },
  };

  const oneX = calculateTradeRecommendation({
    ...common,
    override: {
      selectedPositionNotional: "350",
      selectedLeverage: "1",
    },
  });

  const fiveX = calculateTradeRecommendation({
    ...common,
    override: {
      selectedPositionNotional: "350",
      selectedLeverage: "5",
    },
  });

  assert.equal(oneX.selectedRiskAmount, "35");
  assert.equal(fiveX.selectedRiskAmount, "35");
  assert.equal(oneX.selectedRequiredMargin, "350");
  assert.equal(fiveX.selectedRequiredMargin, "70");
});

test("risk engine rejects stop on the profit side, excessive risk, leverage and margin", () => {
  const base = {
    account: account(),
    policy: {
      targetRiskFraction: "0.01",
      reserveFraction: "0.2",
      maxLeverage: "3",
      marginMode: "ISOLATED",
    },
  };

  assert.throws(
    () =>
      calculateTradeRecommendation({
        ...base,
        signal: {
          signalId: "signal-a",
          direction: "LONG",
          entryPrice: "100",
          stopPrice: "101",
        },
      }),
    /loss side/u,
  );

  assert.throws(
    () =>
      calculateTradeRecommendation({
        ...base,
        signal: {
          signalId: "signal-a",
          direction: "LONG",
          entryPrice: "100",
          stopPrice: "90",
        },
        override: {
          selectedPositionNotional: "600",
        },
      }),
    /target risk/u,
  );

  assert.throws(
    () =>
      calculateTradeRecommendation({
        ...base,
        signal: {
          signalId: "signal-a",
          direction: "LONG",
          entryPrice: "100",
          stopPrice: "90",
        },
        override: {
          selectedPositionNotional: "350",
          selectedLeverage: "4",
        },
      }),
    /maxLeverage/u,
  );
});

test("SHORT risk geometry requires stop above entry and produces exact risk", () => {
  const result = calculateTradeRecommendation({
    account: account(),
    signal: {
      signalId: "signal-short",
      direction: "SHORT",
      entryPrice: "100",
      stopPrice: "105",
    },
    policy: {
      targetRiskFraction: "0.01",
      reserveFraction: "0.2",
      maxLeverage: "10",
      marginMode: "ISOLATED",
    },
  });

  assert.equal(result.stopDistanceFraction, "0.05");
  assert.equal(result.suggestedPositionNotional, "1000");
  assert.equal(result.selectedRiskAmount, "50");
});

test("deterministic fake provider is user/account scoped and stores no credential", async () => {
  const provider = new DeterministicExchangeAccountSnapshotProvider([
    {
      request: {
        userId: "user-a",
        exchange: "binance",
        accountReference: "demo-main",
        currency: "USDT",
      },
      snapshot: account(),
    },
  ]);

  const snapshot = await provider.getSnapshot({
    userId: "user-a",
    exchange: "binance",
    accountReference: "demo-main",
    currency: "USDT",
  });

  assert.equal(snapshot.availableBalance, "5000");
  assert.equal("apiKey" in snapshot, false);
  assert.equal("secret" in snapshot, false);

  await assert.rejects(
    () =>
      provider.getSnapshot({
        userId: "user-b",
        exchange: "binance",
        accountReference: "demo-main",
        currency: "USDT",
      }),
    /unavailable/u,
  );
});

test("planning service preserves user ownership and persists snapshot + selected recommendation", async () => {
  const savedInputs = [];
  const repository = {
    async findOwnedParticipation(userId, participationId) {
      assert.equal(userId, "user-a");
      assert.equal(participationId, "participation-a");
      return {
        participationId,
        userId,
        signalId: "signal-a",
        status: "FOLLOWING",
      };
    },
    async savePlan(input) {
      savedInputs.push(input);
      return {
        tradePlanId: input.tradePlanId,
        balanceSnapshotId: input.balanceSnapshotId,
        participationId: input.participation.participationId,
        userId: input.participation.userId,
        signalId: input.participation.signalId,
        plannedEntryPrice: input.entryPrice,
        originalSignalStopPrice: input.originalSignalStopPrice,
        selectedStopPrice: input.originalSignalStopPrice,
        suggestedPositionNotional: input.recommendation.suggestedPositionNotional,
        selectedPositionNotional: input.recommendation.selectedPositionNotional,
        riskAmount: input.recommendation.selectedRiskAmount,
        riskFraction: input.recommendation.selectedRiskFraction,
        suggestedLeverage: input.recommendation.suggestedLeverage,
        leverage: input.recommendation.selectedLeverage,
        requiredMargin: input.recommendation.selectedRequiredMargin,
        marginMode: input.recommendation.marginMode,
        valueSource: input.recommendation.valueSource,
        createdAt: input.observedAt,
        updatedAt: input.observedAt,
        lockedAt: null,
      };
    },
  };

  const provider = new DeterministicExchangeAccountSnapshotProvider([
    {
      request: {
        userId: "user-a",
        exchange: "binance",
        accountReference: "demo-main",
        currency: "USDT",
      },
      snapshot: account(),
    },
  ]);

  const service = new UserTradePlanningService({
    repository,
    accountProvider: provider,
    clock: { nowIso: () => "2026-10-11T16:10:00.000Z" },
    idFactory: {
      createTradePlanId: () => "plan-a",
      createBalanceSnapshotId: () => "balance-a",
    },
  });

  const result = await service.buildPlan({
    userId: "user-a",
    participationId: "participation-a",
    signal: {
      signalId: "signal-a",
      direction: "LONG",
      entryPrice: "100",
      stopPrice: "90",
    },
    account: {
      exchange: "binance",
      accountReference: "demo-main",
      currency: "USDT",
    },
    policy: {
      targetRiskFraction: "0.01",
      reserveFraction: "0.2",
      maxLeverage: "10",
      marginMode: "ISOLATED",
    },
    override: {
      selectedPositionNotional: "350",
      selectedLeverage: "2",
    },
  });

  assert.equal(result.kind, "PLANNED");
  assert.equal(result.plan.userId, "user-a");
  assert.equal(result.plan.selectedPositionNotional, "350");
  assert.equal(result.plan.suggestedPositionNotional, "500");
  assert.equal(result.plan.leverage, "2");
  assert.equal(result.plan.suggestedLeverage, "1");
  assert.equal(result.plan.requiredMargin, "175");
  assert.equal(savedInputs.length, 1);
  assert.equal(savedInputs[0].snapshot.availableBalance, "5000");
});

test("planning service collapses foreign/missing participation to NOT_FOUND", async () => {
  const provider = new DeterministicExchangeAccountSnapshotProvider([]);
  const service = new UserTradePlanningService({
    repository: {
      async findOwnedParticipation() {
        return null;
      },
      async savePlan() {
        throw new Error("must not save");
      },
    },
    accountProvider: provider,
    clock: { nowIso: () => "2026-10-11T16:10:00.000Z" },
    idFactory: {
      createTradePlanId: () => "plan-a",
      createBalanceSnapshotId: () => "balance-a",
    },
  });

  assert.deepEqual(
    await service.buildPlan({
      userId: "user-a",
      participationId: "foreign",
      signal: {
        signalId: "signal-a",
        direction: "LONG",
        entryPrice: "100",
        stopPrice: "90",
      },
      account: {
        exchange: "binance",
        accountReference: "demo-main",
        currency: "USDT",
      },
      policy: {
        targetRiskFraction: "0.01",
        reserveFraction: "0.2",
        maxLeverage: "10",
        marginMode: "ISOLATED",
      },
    }),
    { kind: "NOT_FOUND" },
  );
});

test("Postgres planning repository keeps ownership predicates and transaction boundary", async () => {
  const calls = [];
  const db = {
    async query(text, values = []) {
      calls.push({ scope: "pool", text, values });
      return { rows: [] };
    },
    async connect() {
      return {
        async query(text, values = []) {
          calls.push({ scope: "tx", text, values });
          if (/FOR UPDATE/u.test(text)) {
            return {
              rows: [{
                participation_id: "p-1",
                user_id: "user-a",
                signal_id: "signal-a",
                status: "FOLLOWING",
              }],
            };
          }
          if (/INSERT INTO app\.user_trade_plan/u.test(text)) {
            return { rows: [] };
          }
          return { rows: [] };
        },
        release() {
          calls.push({ scope: "release", text: "", values: [] });
        },
      };
    },
  };

  const repo = new PostgresTradePlanningRepository(db);
  await repo.findOwnedParticipation("user-a' OR 1=1 --", "p-1");

  assert.match(
    calls[0].text,
    /WHERE user_id = \$1[\s\S]*participation_id = \$2/u,
  );
  assert.doesNotMatch(calls[0].text, /OR 1=1/u);
});

test("planning source imports no frozen auth/security implementation", async () => {
  const { readFileSync } = await import("node:fs");
  const files = [
    "src/user-trading/planning/decimal.ts",
    "src/user-trading/planning/types.ts",
    "src/user-trading/planning/account-snapshot-provider.ts",
    "src/user-trading/planning/risk-engine.ts",
    "src/user-trading/planning/repository.ts",
    "src/user-trading/planning/postgres-repository.ts",
    "src/user-trading/planning/service.ts",
    "src/user-trading/planning/index.ts",
  ];

  for (const file of files) {
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(
      source,
      /from\s+["'][^"']*(?:\/auth\/|\/security\/|require-session|better-auth)/iu,
      `${file} must remain auth/security implementation independent`,
    );
  }
});
