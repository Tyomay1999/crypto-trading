import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  readDrSourceBundles,
} from "../dist/aggregator/dr-source.js";

test("DR SQLite helper reads authoritative tables through a query-only source boundary", async (t) => {
  const directory = await mkdtemp(
    join(tmpdir(), "delta-p11-source-"),
  );
  t.after(async () => {
    await rm(directory, {
      recursive: true,
      force: true,
    });
  });

  const database = join(directory, "dr.sqlite3");
  const creator = join(directory, "create.py");

  await writeFile(
    creator,
    `
import json
import sqlite3
import sys

db = sqlite3.connect(sys.argv[1])
db.executescript("""
CREATE TABLE signal_lifecycles (
  signal_lifecycle_id TEXT PRIMARY KEY,
  paper_trade_plan_id TEXT NOT NULL,
  exchange TEXT NOT NULL,
  market TEXT NOT NULL,
  symbol TEXT NOT NULL,
  published_at TEXT NOT NULL
);
CREATE TABLE paper_trade_plans (
  paper_trade_plan_id TEXT PRIMARY KEY,
  exchange TEXT NOT NULL,
  market TEXT NOT NULL,
  symbol TEXT NOT NULL,
  direction TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  canonical_plan BLOB NOT NULL
);
CREATE TABLE signal_lifecycle_events (
  signal_lifecycle_event_id TEXT PRIMARY KEY,
  signal_lifecycle_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  canonical_event BLOB NOT NULL
);
CREATE TABLE signal_lifecycle_state_revisions (
  signal_lifecycle_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  sequence INTEGER NOT NULL,
  current_state TEXT NOT NULL,
  as_of TEXT NOT NULL,
  terminal_at TEXT,
  canonical_state BLOB NOT NULL,
  PRIMARY KEY (signal_lifecycle_id, revision)
);
CREATE TABLE signal_outcomes (
  signal_outcome_id TEXT PRIMARY KEY,
  signal_lifecycle_id TEXT NOT NULL,
  lifecycle_revision INTEGER NOT NULL,
  as_of TEXT NOT NULL,
  final_status TEXT NOT NULL,
  quality_status TEXT NOT NULL,
  canonical_outcome BLOB NOT NULL
);
""")

signal = "s1"
plan = "p1"
published = "2026-10-10T10:00:00.000Z"

db.execute(
  "INSERT INTO signal_lifecycles VALUES (?, ?, ?, ?, ?, ?)",
  (signal, plan, "binance", "usdm_futures", "ETHUSDT", published),
)

canonical_plan = {
  "contractName": "PaperTradePlan",
  "contractVersion": 1,
  "planSchemaVersion": 1,
  "paperTradePlanId": plan,
}
db.execute(
  "INSERT INTO paper_trade_plans VALUES (?, ?, ?, ?, ?, ?, ?)",
  (
    plan,
    "binance",
    "usdm_futures",
    "ETHUSDT",
    "LONG",
    "2026-10-11T10:00:00.000Z",
    json.dumps(canonical_plan).encode(),
  ),
)

event = {
  "contractName": "SignalLifecycleEvent",
  "contractVersion": 1,
  "eventSchemaVersion": 1,
  "signalLifecycleEventId": "e1",
  "signalLifecycleId": signal,
  "sequence": 1,
  "eventType": "SIGNAL_PUBLISHED",
  "fromState": None,
  "toState": "PUBLISHED",
  "occurredAt": published,
  "price": None,
  "allocationFraction": None,
  "reasonCodes": ["PUBLISHED"],
}
db.execute(
  "INSERT INTO signal_lifecycle_events VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  (
    "e1",
    signal,
    1,
    "SIGNAL_PUBLISHED",
    None,
    "PUBLISHED",
    published,
    json.dumps(event).encode(),
  ),
)

state = {
  "contractName": "SignalLifecycleState",
  "contractVersion": 1,
  "stateSchemaVersion": 1,
  "signalLifecycleId": signal,
  "sequence": 1,
  "currentState": "PUBLISHED",
  "asOf": published,
}
db.execute(
  "INSERT INTO signal_lifecycle_state_revisions VALUES (?, ?, ?, ?, ?, ?, ?)",
  (
    signal,
    1,
    1,
    "PUBLISHED",
    published,
    None,
    json.dumps(state).encode(),
  ),
)

db.commit()
db.close()
`,
    "utf8",
  );

  const create = spawnSync(
    "python3",
    [creator, database],
    { encoding: "utf8" },
  );
  assert.equal(
    create.status,
    0,
    create.stderr,
  );

  const before = await stat(database);
  const helper = resolve(
    process.cwd(),
    "tools/dr-sqlite-export.py",
  );

  const bundles = [];
  for await (
    const value of readDrSourceBundles({
      databasePath: database,
      helperPath: helper,
    })
  ) {
    bundles.push(value);
  }

  const after = await stat(database);

  assert.equal(bundles.length, 1);
  assert.equal(
    bundles[0].lifecycle.signal_lifecycle_id,
    "s1",
  );
  assert.equal(
    bundles[0].events[0].canonical.eventType,
    "SIGNAL_PUBLISHED",
  );
  assert.equal(bundles[0].outcome, null);
  assert.equal(
    before.size,
    after.size,
    "read-only helper changed SQLite file size",
  );

  const helperSource = await readFile(
    helper,
    "utf8",
  );
  assert.match(helperSource, /mode=ro/);
  assert.match(helperSource, /PRAGMA query_only = ON/);
});
