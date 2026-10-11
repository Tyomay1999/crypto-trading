# DELTA U1 — User Trading Domain Architecture / Contract Preregistration

Status: **PREREGISTERED — NO IMPLEMENTATION YET**

This document freezes the design boundary for the U2+ implementation chain.
It does not mutate auth/security, projection semantics, production DR, or mobile.

## 1. Frozen boundaries

The following remain authoritative and unchanged:

- Better Auth / `auth.*` owns authentication, identities, credentials and sessions.
- Authenticated application identity is the server-resolved `userId` from the existing session context.
- `projection.*` owns the global signal truth.
- Simulator and future DR/P11 Aggregator both write the same projection contract.
- User trading state is application-owned and must not be stored in `auth.*`.
- Client requests never provide an authoritative user ID.
- Real exchange execution and production exchange credentials are out of scope.

## 2. Identity and ownership

Canonical user identity:

```text
auth."user"."id" : TEXT
```

Every user-trading operation receives identity only as:

```text
authenticated request
  -> existing require-session middleware
  -> existing safe CurrentSessionContext.userId
  -> user-trading service
```

Ordinary user routes MUST NOT accept `userId` in route parameters, query strings, or request bodies.

Global signal ownership:

```text
projection.published_signals.signal_id
```

User-specific records are scoped by both user identity and signal identity, but a user may have more than one historical participation attempt for the same global signal. Therefore `(user_id, signal_id)` is not the primary identity of the entire history.

Canonical attempt identity:

```text
participation_id TEXT
```

generated server-side and opaque to domain semantics.

## 3. Schema ownership

U2 SHOULD add a new migration after `0008_projection_foundation.sql`.

All new tables live in schema `app`.

Proposed canonical tables:

```text
app.user_signal_participation
app.user_trade_plan
app.user_balance_snapshot
app.user_position
app.user_position_event
app.user_position_outcome
```

No user-trading table is added to `auth.*`.
No user-specific column is added to `projection.*`.

### 3.1 `app.user_signal_participation`

Purpose: durable record that the authenticated user chose to follow/participate in one global signal.

Core identity:

```text
participation_id TEXT PRIMARY KEY
user_id          TEXT NOT NULL REFERENCES auth."user"("id") ON DELETE CASCADE
signal_id        TEXT NOT NULL REFERENCES projection.published_signals(signal_id) ON DELETE RESTRICT
```

Core timestamps/state:

```text
status
subscribed_at
unsubscribed_at nullable
created_at
updated_at
```

The schema MUST permit historical re-participation in the same signal, while preventing more than one live participation attempt for the same `(user_id, signal_id)`.

This should be enforced transactionally and, where feasible, by a partial unique index over live/nonterminal participation statuses.

### 3.2 `app.user_trade_plan`

Exactly one current plan belongs to one participation attempt.

Ownership:

```text
participation_id TEXT UNIQUE NOT NULL
user_id          TEXT NOT NULL
signal_id        TEXT NOT NULL
```

The duplicated user/signal ownership is intentional for fail-closed composite checks and query locality, but must be constrained to match the participation owner.

Planned financial values are canonical decimal strings at TypeScript/API boundaries.

Plan captures at minimum:

```text
entry_basis
planned_entry_price
original_signal_stop_price
selected_stop_price
suggested_position_notional
selected_position_notional
risk_amount
risk_fraction
leverage
margin_mode
value_source           SYSTEM_SUGGESTED | USER_OVERRIDE
created_at
updated_at
locked_at nullable
```

U2 must choose PostgreSQL representation that preserves exact decimal semantics.
No IEEE-754 floating-point column may become authoritative.

### 3.3 `app.user_balance_snapshot`

Immutable planning evidence.

At minimum:

```text
balance_snapshot_id
user_id
participation_id
provider_kind
exchange
account_reference nullable
currency
available_balance
equity nullable
observed_at
created_at
```

For U4/U8 local E2E, provider kind is a deterministic fake/local provider.

No API secret, exchange secret, token, private credential, or session token may be stored here.

### 3.4 `app.user_position`

Mutable current snapshot for one participation.

Exactly one position per participation attempt.

At minimum:

```text
position_id
participation_id UNIQUE
user_id
signal_id
state
actual_entry_price nullable
entered_at nullable
initial_quantity nullable
initial_notional nullable
remaining_fraction
selected_stop_price
last_global_sequence
last_global_state
version
created_at
updated_at
terminal_at nullable
```

`version` is used for optimistic/transactional concurrency protection where useful.

The current row is a snapshot, not the accounting ledger.

### 3.5 `app.user_position_event`

Append-only immutable user accounting/action ledger.

At minimum:

```text
event_id TEXT PRIMARY KEY
position_id
participation_id
user_id
signal_id
event_type
event_identity TEXT NOT NULL
global_event_identity nullable
global_sequence nullable
occurred_at
observed_at
payload
created_at
```

Mandatory invariant:

```text
UNIQUE (position_id, event_identity)
```

or a stronger equivalent.

This prevents repeated polling, replayed global lifecycle observations and duplicate user requests from double-booking P&L.

`payload` must contain only validated domain data and canonical decimal strings.

### 3.6 `app.user_position_outcome`

Immutable terminal user result.

Exactly one terminal outcome per position.

At minimum:

```text
position_id UNIQUE
participation_id UNIQUE
user_id
signal_id
terminal_reason
user_terminal_state
global_terminal_status nullable
actual_exit_price nullable
realized_pnl
realized_return
realized_fraction
fees
theoretical_global_pnl nullable
opportunity_delta nullable
completed_at
global_completed_at nullable
created_at
```

User terminal result and global signal terminal result are separate facts.

A user position may become terminal before the global signal.

## 4. Domain state machines

### 4.1 Participation state

Canonical U1 state proposal:

```text
FOLLOWING
PLANNED
ACTIVE
EXITED_EARLY
COMPLETED
STOPPED
CANCELLED
```

Rules:

- `FOLLOWING`: user follows signal but has no locked execution plan.
- `PLANNED`: authoritative plan exists but no entry has been recorded.
- `ACTIVE`: entry exists and some position remains.
- `EXITED_EARLY`: user voluntarily closed the remaining position before global terminal.
- `COMPLETED`: user position fully realized through TP lifecycle.
- `STOPPED`: final remaining user position realized at stop.
- `CANCELLED`: user explicitly cancelled before entry.

`EXITED_EARLY`, `COMPLETED`, `STOPPED`, `CANCELLED` are terminal user states.

An unsubscribe after entry is NOT equivalent to deleting the position.

### 4.2 Position state

Canonical accounting state:

```text
PENDING_ENTRY
OPEN
PARTIALLY_REALIZED
EXITED_EARLY
COMPLETED
STOPPED
CANCELLED
```

A global signal state is never copied as the authoritative user position state.

Example:

```text
global: TP2_REACHED
user:   EXITED_EARLY
```

is valid and expected.

## 5. User event taxonomy

Initial canonical taxonomy:

```text
SIGNAL_FOLLOWED
SIGNAL_UNFOLLOWED
TRADE_PLAN_CREATED
TRADE_PLAN_UPDATED
BALANCE_SNAPSHOT_CAPTURED
POSITION_SIZE_SUGGESTED
POSITION_SIZE_OVERRIDDEN
ENTRY_RECORDED
STOP_UPDATED
STOP_MOVED_TO_ENTRY
TP_REALIZED
PARTIAL_EXIT_RECORDED
MANUAL_EXIT_RECORDED
STOP_REALIZED
POSITION_COMPLETED
POSITION_CANCELLED
GLOBAL_OUTCOME_OBSERVED
```

The exact persisted enum/check constraint may be refined in U2/U5, but semantic meanings above are preregistered.

No accounting-relevant historical event is implemented only as mutation of the current snapshot.

## 6. Global lifecycle adapter boundary

User accounting consumes projection truth through an application service boundary, conceptually:

```text
projection.* reader
  -> GlobalSignalObservation
  -> UserPositionAccountingEngine
```

`UserPositionAccountingEngine` must not import or depend on:

```text
dev-simulator/*
simulator/*
aggregator/*
DR-specific source types
```

It receives normalized projection-domain observations only.

Therefore:

```text
today:
Simulator -> projection.* -> user trading domain

production:
DR -> P11 Aggregator -> projection.* -> user trading domain
```

requires no redesign.

## 7. Accounting model

All values crossing persistence/API boundaries are decimal strings.

JS `number` is not authoritative for:

```text
price
quantity
notional
balance
risk
allocation
P&L
return
fees
```

U0 found no decimal arithmetic dependency in backend package.json.
Therefore U2/U5 must not silently add one.

Before U5 calculation implementation:

1. inspect whether exact arithmetic can be safely implemented with integer-scaled/bigint helpers;
2. otherwise preregister and justify one decimal dependency;
3. dependency addition requires explicit evidence in the U5 stage but no separate authorization gate.

### 7.1 Allocation

Use the signal's actual canonical allocation fractions from projection.

Do not hardcode `0.30 / 0.30 / 0.40` as a platform invariant.

For a specific signal whose plan is:

```text
TP1 0.30
TP2 0.30
TP3 0.40
```

remaining fraction becomes:

```text
entry: 1.00
TP1:   0.70
TP2:   0.40
TP3:   0.00
```

### 7.2 Realized accounting

For each realization event:

```text
closed quantity/fraction
execution/realization price
entry price
direction
fee amount
realized P&L
```

are persisted or reproducibly derivable from immutable ledger inputs.

STOP after TP1/TP2 realizes only the remaining portion.

Manual exit realizes only the user quantity/fraction still open.

### 7.3 Actual vs theoretical

Two metrics remain separate:

```text
realized_user_pnl
theoretical_global_pnl
```

Optional derived:

```text
opportunity_delta =
  theoretical_global_pnl - realized_user_pnl
```

Opportunity delta is analytics, not realized P&L.

## 8. Balance / sizing provider

Backend-owned interface proposal:

```text
ExchangeAccountSnapshotProvider
```

Normalized result:

```text
availableBalance
equity
currency
exchange
accountReference
observedAt
providerKind
```

U4 local implementation uses deterministic fake data.
No real exchange request is required for U1-U15 acceptance unless separately authorized later.

Position suggestion service receives:

```text
balance snapshot
risk fraction
entry
stop
direction
leverage constraints
user preference inputs
```

User override becomes authoritative selected position size while preserving suggested value.

## 9. API contract direction

All routes are authenticated through the existing session middleware.

Proposed namespace:

```text
/api/v1/me/trading
```

This makes server-owned user scope explicit and avoids client-supplied user IDs.

Candidate U7 contract:

```text
GET    /api/v1/me/trading/signals/:signalId
POST   /api/v1/me/trading/signals/:signalId/follow
POST   /api/v1/me/trading/participations/:participationId/plan
POST   /api/v1/me/trading/participations/:participationId/entry
POST   /api/v1/me/trading/positions/:positionId/stop
POST   /api/v1/me/trading/positions/:positionId/exit
GET    /api/v1/me/trading/positions
GET    /api/v1/me/trading/positions/:positionId
GET    /api/v1/me/trading/positions/:positionId/events
GET    /api/v1/me/trading/history
GET    /api/v1/me/trading/reports/summary
```

These are directionally preregistered; U7 may refine verbs/path shape before implementation if tests show an existing routing convention requires it.

Every storage operation takes authoritative `session.userId` separately from client-owned identifiers and scopes SQL by that user.

Foreign/missing resources should be indistinguishable where necessary to prevent cross-user enumeration.

## 10. Idempotency / concurrency

Mandatory cases:

- double follow;
- duplicate plan submission;
- duplicate entry;
- duplicate TP observation;
- repeated mobile polling;
- repeated global lifecycle observation;
- replayed projection event;
- two concurrent manual exits;
- manual exit racing a TP/STOP observation;
- duplicate terminalization.

Controls:

```text
immutable event identity
unique constraints
transaction boundary
row lock / compare-and-set where needed
single terminal outcome constraint
monotonic last_global_sequence
```

No P&L may be booked twice.

## 11. Mobile migration strategy

Existing mobile P2-X components are treated as UI/domain prototypes, not authority.

Preserve and adapt rather than discard:

```text
subscription-store
user-trade-plan-store
trade-plan domain
risk-planner
execution provider boundary
pre-subscribe trade setup card
user trade controls card
focused signal polling
```

Migration order:

1. add backend user-trading provider/contracts;
2. hydrate server participation/position into existing screens;
3. replace local subscription authority with backend authority;
4. replace local plan authority with backend authority;
5. preserve optimistic UX only where server reconciliation is deterministic;
6. keep global signal provider separate from user-trading provider.

Mobile must not calculate authoritative realized P&L.

## 12. Security invariants

- existing auth/security source remains frozen;
- `auth.*` migrations remain untouched;
- user ID comes only from authenticated session;
- no request-body/query user ID override;
- no session token stored in user trading tables;
- no exchange secret stored in user trading tables;
- user A cannot read/write user B records;
- terminal accounting is immutable;
- duplicate actions are idempotent;
- race conditions fail closed.

## 13. U2–U15 execution plan

### U2 — PostgreSQL foundation
Create migration `0009_*` and migration contract tests only.
No business API yet.

### U3 — participation domain
Storage + service for follow/unfollow/cancel-before-entry, with idempotency.

### U4 — plan / balance / risk
Persistent plan, deterministic fake account snapshot provider and size suggestion/override model.

### U5 — accounting engine
Pure deterministic position accounting and decimal-safe arithmetic.

### U6 — event ledger / outcomes
Transactional persistence of current snapshot + immutable event + terminal outcome.

### U7 — authenticated Node API
`/api/v1/me/trading/*`, existing session middleware, cross-user fail-closed tests.

### U8 — projection lifecycle integration
Projection observation -> user accounting reconciliation; simulator-driven.

### U9 — reports
User realized performance, date/symbol/strategy/direction aggregates.

### U10 — mobile Signals / Details
Backend participation/plan/position/actions.

### U11 — mobile History / Reports
User-specific history and analytics.

### U12 — multi-user isolation
At least one real disposable auth user plus controlled second-user isolation coverage.

### U13 — Web E2E
Complete production-like simulator flow.

### U14 — iPhone E2E
Same contract through Expo physical-device path.

### U15 — full regression / final handoff
Backend full test suite, mobile checks, evidence, commit summary. Push/tag/merge remain separately prohibited.

## 14. Required U2 acceptance gates

U2 must prove:

1. migrations `0001–0008` bytes unchanged;
2. new migration number is `0009`;
3. no `ALTER TABLE auth.*`;
4. no `ALTER TABLE projection.*`;
5. all user-domain tables are `app.*`;
6. `user_id` references `auth."user"("id")`;
7. `signal_id` references `projection.published_signals(signal_id)`;
8. user events have deterministic uniqueness;
9. terminal outcome is one-per-position;
10. no floating-point authoritative monetary columns;
11. migration applies to disposable PostgreSQL;
12. full existing backend regression passes;
13. production/VPS untouched.

## 15. Deferred decisions

These are intentionally deferred to the implementation stage where evidence is available:

- exact decimal arithmetic implementation/library;
- exact database CHECK enum syntax;
- exact server-generated opaque ID encoding;
- exact API response envelope for user trading routes;
- real exchange account provider;
- fees/slippage model beyond deterministic local E2E;
- complex BI/materialized analytics.

None of these deferred items changes the frozen domain boundaries above.
