import assert from "node:assert/strict";
import test from "node:test";

const {
  PostgresPlanningSignalResolver,
} =
  await import(
    "../dist/user-trading/api/index.js"
  );

test(
  "planning resolver derives risk facts only from projection payload",
  async () => {
    const calls = [];
    const resolver =
      new PostgresPlanningSignalResolver({
        async query(text,values) {
          calls.push({text,values});
          return {
            rows:[{
              signal_id:"s-1",
              exchange:"binance",
              direction:"LONG",
              projection_payload:{
                signalId:"s-1",
                tradePlan:{
                  entry:{
                    referencePrice:"100",
                  },
                  stopLoss:{
                    price:"90",
                  },
                },
              },
            }],
          };
        },
      });

    const result =
      await resolver.getSignalFacts(
        "s-1",
      );

    assert.deepEqual(
      result,
      {
        signal:{
          signalId:"s-1",
          direction:"LONG",
          entryPrice:"100",
          stopPrice:"90",
        },
        exchange:"binance",
      },
    );

    assert.equal(
      calls[0].values[0],
      "s-1",
    );
    assert.match(
      calls[0].text,
      /FROM projection\.published_signals/u,
    );
    assert.doesNotMatch(
      calls[0].text,
      /\b(?:INSERT|UPDATE|DELETE)\b/iu,
    );
  },
);
