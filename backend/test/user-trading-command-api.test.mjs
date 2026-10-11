import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import http from "node:http";

const {
  createUserTradingRouter,
} =
  await import(
    "../dist/user-trading/api/index.js"
  );

async function request(
  app,
  method,
  path,
  body,
) {
  const server =
    http.createServer(app);

  await new Promise((resolve) =>
    server.listen(
      0,
      "127.0.0.1",
      resolve,
    ),
  );

  try {
    const address = server.address();
    if (
      !address ||
      typeof address === "string"
    ) {
      throw new Error(
        "invalid test server address",
      );
    }

    const response =
      await fetch(
        `http://127.0.0.1:${address.port}${path}`,
        {
          method,
          headers:{
            "content-type":
              "application/json",
          },
          body:
            body === undefined
              ? undefined
              : JSON.stringify(body),
        },
      );

    const text =
      await response.text();

    return {
      status:response.status,
      body:
        text.length === 0
          ? {}
          : JSON.parse(text),
    };
  } finally {
    await new Promise((resolve) =>
      server.close(resolve),
    );
  }
}

function harness() {
  const calls = [];
  const deps = {
    readRepository:{
      async listParticipations(userId) {
        calls.push([
          "list",
          userId,
        ]);
        return [{
          participationId:"p-1",
          signalId:"s-1",
          state:"FOLLOWING",
          subscribedAt:
            "2026-10-11T18:00:00.000Z",
          unsubscribedAt:null,
        }];
      },
      async getPositionDetail() {
        return null;
      },
    },
    ledgerService:{
      async moveStop() {
        throw new Error("unused");
      },
      async manualExit() {
        throw new Error("unused");
      },
    },
    participationService:{
      async followSignal(userId, signalId) {
        calls.push([
          "follow",
          userId,
          signalId,
        ]);
        return {
          kind:"CREATED",
          participation:{
            participationId:"p-1",
            userId,
            signalId,
            status:"FOLLOWING",
          },
        };
      },
      async unfollowParticipation(
        userId,
        participationId,
      ) {
        calls.push([
          "unfollow",
          userId,
          participationId,
        ]);
        return {
          kind:"CANCELLED",
          participation:{
            participationId,
            userId,
            signalId:"s-1",
            status:"CANCELLED",
          },
        };
      },
    },
    planningSignalResolver:{
      async getSignalFacts(signalId) {
        calls.push([
          "facts",
          signalId,
        ]);
        return {
          signal:{
            signalId,
            direction:"LONG",
            entryPrice:"100",
            stopPrice:"90",
          },
          exchange:"binance",
        };
      },
    },
    planningService:{
      async buildPlan(input) {
        calls.push([
          "plan",
          input,
        ]);
        return {
          kind:"PLANNED",
          plan:{},
          snapshot:{
            availableBalance:"5000",
          },
          recommendation:{
            suggestedPositionNotional:"500",
            selectedPositionNotional:"350",
          },
        };
      },
    },
    resolveTrustedContext() {
      return {userId:"user-a"};
    },
  };

  const app = express();
  app.use(express.json());
  app.use(
    "/api/v1/me/trading",
    createUserTradingRouter(deps),
  );
  app.use(
    (error,_req,res,_next) => {
      res.status(
        error instanceof TypeError
          ? 400
          : 500,
      ).json({
        error:{
          code:
            error instanceof TypeError
              ? "BAD_REQUEST"
              : "INTERNAL",
        },
      });
    },
  );

  return {app,calls};
}

test(
  "follow uses trusted user identity",
  async () => {
    const h = harness();
    const response =
      await request(
        h.app,
        "POST",
        "/api/v1/me/trading/signals/s-1/follow",
        {},
      );

    assert.equal(
      response.status,
      200,
    );
    assert.deepEqual(
      h.calls[0],
      ["follow","user-a","s-1"],
    );
  },
);

test(
  "follow rejects client user identity",
  async () => {
    const h = harness();
    const response =
      await request(
        h.app,
        "POST",
        "/api/v1/me/trading/signals/s-1/follow",
        {userId:"user-b"},
      );

    assert.equal(
      response.status,
      400,
    );
    assert.equal(
      h.calls.length,
      0,
    );
  },
);

test(
  "unfollow uses trusted user identity",
  async () => {
    const h = harness();
    const response =
      await request(
        h.app,
        "POST",
        "/api/v1/me/trading/participations/p-1/unfollow",
        {},
      );

    assert.equal(
      response.status,
      200,
    );
    assert.deepEqual(
      h.calls[0],
      ["unfollow","user-a","p-1"],
    );
  },
);

test(
  "plan derives global signal facts server side",
  async () => {
    const h = harness();
    const response =
      await request(
        h.app,
        "POST",
        "/api/v1/me/trading/participations/p-1/plan",
        {
          accountReference:"demo-main",
          currency:"USDT",
          policy:{
            targetRiskFraction:"0.01",
            reserveFraction:"0.2",
            maxLeverage:"10",
            marginMode:"ISOLATED",
          },
          override:{
            selectedPositionNotional:"350",
            selectedLeverage:"2",
          },
        },
      );

    assert.equal(
      response.status,
      200,
    );

    const planCall =
      h.calls.find(
        ([name]) => name === "plan",
      );

    assert.ok(planCall);
    assert.equal(
      planCall[1].userId,
      "user-a",
    );
    assert.deepEqual(
      planCall[1].signal,
      {
        signalId:"s-1",
        direction:"LONG",
        entryPrice:"100",
        stopPrice:"90",
      },
    );
    assert.equal(
      planCall[1].account.exchange,
      "binance",
    );
    assert.equal(
      planCall[1].override
        .selectedPositionNotional,
      "350",
    );
  },
);

test(
  "plan rejects client-authoritative signal and balance facts",
  async () => {
    for (
      const field of [
        "signalId",
        "direction",
        "entryPrice",
        "stopPrice",
        "exchange",
        "availableBalance",
        "equity",
        "userId",
      ]
    ) {
      const h = harness();
      const response =
        await request(
          h.app,
          "POST",
          "/api/v1/me/trading/participations/p-1/plan",
          {
            [field]:"attacker-value",
            policy:{
              targetRiskFraction:"0.01",
              reserveFraction:"0.2",
              maxLeverage:"10",
              marginMode:"ISOLATED",
            },
          },
        );

      assert.equal(
        response.status,
        400,
        field,
      );

      assert.equal(
        h.calls.length,
        0,
        field,
      );
    }
  },
);
