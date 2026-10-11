-- DELTA U2 user-trading foundation.
--
-- Ownership:
--   auth.*       = Better Auth identity/session/security (frozen)
--   projection.* = global signal truth (frozen)
--   app.*        = DELTA application-owned user trading state
--
-- Monetary/price/quantity/return values are persisted as canonical decimal
-- strings. IEEE-754 PostgreSQL floating-point types are intentionally absent.

CREATE TABLE app.user_signal_participation (
    participation_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL
        REFERENCES auth."user" ("id")
        ON DELETE CASCADE,
    signal_id TEXT NOT NULL
        REFERENCES projection.published_signals (signal_id)
        ON DELETE RESTRICT,
    status TEXT NOT NULL
        CHECK (
            status IN (
                'FOLLOWING',
                'PLANNED',
                'ACTIVE',
                'EXITED_EARLY',
                'COMPLETED',
                'STOPPED',
                'CANCELLED'
            )
        ),
    subscribed_at TIMESTAMPTZ NOT NULL,
    unsubscribed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT user_signal_participation_id_shape
        CHECK (
            length(participation_id) BETWEEN 1 AND 128
            AND participation_id = btrim(participation_id)
        ),
    CONSTRAINT user_signal_participation_user_shape
        CHECK (
            length(user_id) BETWEEN 1 AND 256
            AND user_id = btrim(user_id)
        ),
    CONSTRAINT user_signal_participation_signal_shape
        CHECK (
            length(signal_id) BETWEEN 1 AND 256
            AND signal_id = btrim(signal_id)
        ),
    CONSTRAINT user_signal_participation_time_order
        CHECK (
            updated_at >= created_at
            AND (
                unsubscribed_at IS NULL
                OR unsubscribed_at >= subscribed_at
            )
        ),
    CONSTRAINT user_signal_participation_owner_key
        UNIQUE (participation_id, user_id, signal_id)
);

-- Preserve full participation history while preventing more than one live
-- participation attempt for the same authenticated user + global signal.
CREATE UNIQUE INDEX user_signal_participation_one_live_idx
    ON app.user_signal_participation (user_id, signal_id)
    WHERE status IN ('FOLLOWING', 'PLANNED', 'ACTIVE');

CREATE INDEX user_signal_participation_user_status_idx
    ON app.user_signal_participation (user_id, status, updated_at DESC);

CREATE INDEX user_signal_participation_signal_idx
    ON app.user_signal_participation (signal_id);

CREATE TABLE app.user_trade_plan (
    trade_plan_id TEXT PRIMARY KEY,
    participation_id TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL,
    signal_id TEXT NOT NULL,

    entry_basis TEXT NOT NULL
        CHECK (
            entry_basis IN (
                'SIGNAL_REFERENCE',
                'ACTUAL_EXECUTION'
            )
        ),

    planned_entry_price TEXT NOT NULL
        CHECK (planned_entry_price ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$'),
    original_signal_stop_price TEXT NOT NULL
        CHECK (original_signal_stop_price ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$'),
    selected_stop_price TEXT NOT NULL
        CHECK (selected_stop_price ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$'),

    suggested_position_notional TEXT
        CHECK (
            suggested_position_notional IS NULL
            OR suggested_position_notional ~ '^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$'
        ),
    selected_position_notional TEXT
        CHECK (
            selected_position_notional IS NULL
            OR selected_position_notional ~ '^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$'
        ),
    risk_amount TEXT
        CHECK (
            risk_amount IS NULL
            OR risk_amount ~ '^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$'
        ),
    risk_fraction TEXT
        CHECK (
            risk_fraction IS NULL
            OR risk_fraction ~ '^(?:0(?:\.[0-9]+)?|1(?:\.0+)?)$'
        ),

    leverage TEXT
        CHECK (
            leverage IS NULL
            OR leverage ~ '^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$'
        ),
    margin_mode TEXT
        CHECK (
            margin_mode IS NULL
            OR margin_mode IN ('CROSS', 'ISOLATED')
        ),

    value_source TEXT NOT NULL
        CHECK (value_source IN ('SYSTEM_SUGGESTED', 'USER_OVERRIDE')),

    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    locked_at TIMESTAMPTZ,

    CONSTRAINT user_trade_plan_id_shape
        CHECK (
            length(trade_plan_id) BETWEEN 1 AND 128
            AND trade_plan_id = btrim(trade_plan_id)
        ),
    CONSTRAINT user_trade_plan_time_order
        CHECK (
            updated_at >= created_at
            AND (
                locked_at IS NULL
                OR locked_at >= created_at
            )
        ),
    CONSTRAINT user_trade_plan_owner_fk
        FOREIGN KEY (participation_id, user_id, signal_id)
        REFERENCES app.user_signal_participation (
            participation_id,
            user_id,
            signal_id
        )
        ON DELETE CASCADE
);

CREATE INDEX user_trade_plan_user_idx
    ON app.user_trade_plan (user_id, updated_at DESC);

CREATE TABLE app.user_balance_snapshot (
    balance_snapshot_id TEXT PRIMARY KEY,
    participation_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    signal_id TEXT NOT NULL,

    provider_kind TEXT NOT NULL,
    exchange TEXT NOT NULL,
    account_reference TEXT,
    currency TEXT NOT NULL,

    available_balance TEXT NOT NULL
        CHECK (available_balance ~ '^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$'),
    equity TEXT
        CHECK (
            equity IS NULL
            OR equity ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$'
        ),

    observed_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT user_balance_snapshot_id_shape
        CHECK (
            length(balance_snapshot_id) BETWEEN 1 AND 128
            AND balance_snapshot_id = btrim(balance_snapshot_id)
        ),
    CONSTRAINT user_balance_snapshot_provider_shape
        CHECK (
            length(provider_kind) BETWEEN 1 AND 64
            AND provider_kind = btrim(provider_kind)
        ),
    CONSTRAINT user_balance_snapshot_exchange_shape
        CHECK (
            length(exchange) BETWEEN 1 AND 64
            AND exchange = btrim(exchange)
        ),
    CONSTRAINT user_balance_snapshot_currency_shape
        CHECK (
            length(currency) BETWEEN 1 AND 32
            AND currency = btrim(currency)
        ),
    CONSTRAINT user_balance_snapshot_owner_fk
        FOREIGN KEY (participation_id, user_id, signal_id)
        REFERENCES app.user_signal_participation (
            participation_id,
            user_id,
            signal_id
        )
        ON DELETE CASCADE
);

CREATE INDEX user_balance_snapshot_participation_idx
    ON app.user_balance_snapshot (participation_id, observed_at DESC);

CREATE INDEX user_balance_snapshot_user_idx
    ON app.user_balance_snapshot (user_id, observed_at DESC);

CREATE TABLE app.user_position (
    position_id TEXT PRIMARY KEY,
    participation_id TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL,
    signal_id TEXT NOT NULL,

    state TEXT NOT NULL
        CHECK (
            state IN (
                'PENDING_ENTRY',
                'OPEN',
                'PARTIALLY_REALIZED',
                'EXITED_EARLY',
                'COMPLETED',
                'STOPPED',
                'CANCELLED'
            )
        ),

    actual_entry_price TEXT
        CHECK (
            actual_entry_price IS NULL
            OR actual_entry_price ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$'
        ),
    entered_at TIMESTAMPTZ,

    initial_quantity TEXT
        CHECK (
            initial_quantity IS NULL
            OR initial_quantity ~ '^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$'
        ),
    initial_notional TEXT
        CHECK (
            initial_notional IS NULL
            OR initial_notional ~ '^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$'
        ),

    remaining_fraction TEXT NOT NULL DEFAULT '1'
        CHECK (remaining_fraction ~ '^(?:0(?:\.[0-9]+)?|1(?:\.0+)?)$'),

    selected_stop_price TEXT NOT NULL
        CHECK (selected_stop_price ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$'),

    last_global_sequence BIGINT NOT NULL DEFAULT 0
        CHECK (last_global_sequence >= 0),

    last_global_state TEXT
        CHECK (
            last_global_state IS NULL
            OR last_global_state IN (
                'PUBLISHED',
                'WAITING_FOR_ENTRY',
                'ENTRY_REACHED',
                'TP1_REACHED',
                'TP2_REACHED',
                'TP3_REACHED',
                'STOP_REACHED'
            )
        ),

    version BIGINT NOT NULL DEFAULT 1
        CHECK (version > 0),

    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    terminal_at TIMESTAMPTZ,

    CONSTRAINT user_position_id_shape
        CHECK (
            length(position_id) BETWEEN 1 AND 128
            AND position_id = btrim(position_id)
        ),

    CONSTRAINT user_position_terminal_shape
        CHECK (
            (
                state IN ('EXITED_EARLY', 'COMPLETED', 'STOPPED', 'CANCELLED')
                AND terminal_at IS NOT NULL
            )
            OR
            (
                state NOT IN ('EXITED_EARLY', 'COMPLETED', 'STOPPED', 'CANCELLED')
                AND terminal_at IS NULL
            )
        ),

    CONSTRAINT user_position_entry_shape
        CHECK (
            (
                state = 'PENDING_ENTRY'
                AND actual_entry_price IS NULL
                AND entered_at IS NULL
            )
            OR state = 'CANCELLED'
            OR (
                state IN (
                    'OPEN',
                    'PARTIALLY_REALIZED',
                    'EXITED_EARLY',
                    'COMPLETED',
                    'STOPPED'
                )
                AND actual_entry_price IS NOT NULL
                AND entered_at IS NOT NULL
            )
        ),

    CONSTRAINT user_position_owner_fk
        FOREIGN KEY (participation_id, user_id, signal_id)
        REFERENCES app.user_signal_participation (
            participation_id,
            user_id,
            signal_id
        )
        ON DELETE CASCADE,

    CONSTRAINT user_position_owner_key
        UNIQUE (position_id, participation_id, user_id, signal_id)
);

CREATE INDEX user_position_user_state_idx
    ON app.user_position (user_id, state, updated_at DESC);

CREATE INDEX user_position_signal_idx
    ON app.user_position (signal_id);

CREATE TABLE app.user_position_event (
    event_id TEXT PRIMARY KEY,
    position_id TEXT NOT NULL,
    participation_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    signal_id TEXT NOT NULL,

    event_type TEXT NOT NULL
        CHECK (
            event_type IN (
                'SIGNAL_FOLLOWED',
                'SIGNAL_UNFOLLOWED',
                'TRADE_PLAN_CREATED',
                'TRADE_PLAN_UPDATED',
                'BALANCE_SNAPSHOT_CAPTURED',
                'POSITION_SIZE_SUGGESTED',
                'POSITION_SIZE_OVERRIDDEN',
                'ENTRY_RECORDED',
                'STOP_UPDATED',
                'STOP_MOVED_TO_ENTRY',
                'TP_REALIZED',
                'PARTIAL_EXIT_RECORDED',
                'MANUAL_EXIT_RECORDED',
                'STOP_REALIZED',
                'POSITION_COMPLETED',
                'POSITION_CANCELLED',
                'GLOBAL_OUTCOME_OBSERVED'
            )
        ),

    event_identity TEXT NOT NULL,
    global_event_identity TEXT,
    global_sequence BIGINT
        CHECK (global_sequence IS NULL OR global_sequence >= 0),

    occurred_at TIMESTAMPTZ NOT NULL,
    observed_at TIMESTAMPTZ NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT user_position_event_id_shape
        CHECK (
            length(event_id) BETWEEN 1 AND 128
            AND event_id = btrim(event_id)
        ),
    CONSTRAINT user_position_event_identity_shape
        CHECK (
            length(event_identity) BETWEEN 1 AND 256
            AND event_identity = btrim(event_identity)
        ),
    CONSTRAINT user_position_event_owner_fk
        FOREIGN KEY (
            position_id,
            participation_id,
            user_id,
            signal_id
        )
        REFERENCES app.user_position (
            position_id,
            participation_id,
            user_id,
            signal_id
        )
        ON DELETE CASCADE,
    CONSTRAINT user_position_event_idempotency_key
        UNIQUE (position_id, event_identity)
);

CREATE INDEX user_position_event_timeline_idx
    ON app.user_position_event (
        position_id,
        occurred_at,
        created_at,
        event_id
    );

CREATE INDEX user_position_event_user_idx
    ON app.user_position_event (
        user_id,
        occurred_at DESC
    );

CREATE INDEX user_position_event_global_idx
    ON app.user_position_event (
        signal_id,
        global_sequence
    )
    WHERE global_sequence IS NOT NULL;

CREATE TABLE app.user_position_outcome (
    position_id TEXT PRIMARY KEY,
    participation_id TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL,
    signal_id TEXT NOT NULL,

    terminal_reason TEXT NOT NULL,
    user_terminal_state TEXT NOT NULL
        CHECK (
            user_terminal_state IN (
                'EXITED_EARLY',
                'COMPLETED',
                'STOPPED',
                'CANCELLED'
            )
        ),

    global_terminal_status TEXT
        CHECK (
            global_terminal_status IS NULL
            OR global_terminal_status IN ('STOP', 'TP3')
        ),

    actual_exit_price TEXT
        CHECK (
            actual_exit_price IS NULL
            OR actual_exit_price ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$'
        ),

    realized_pnl TEXT NOT NULL
        CHECK (realized_pnl ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$'),
    realized_return TEXT NOT NULL
        CHECK (realized_return ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$'),
    realized_fraction TEXT NOT NULL
        CHECK (realized_fraction ~ '^(?:0(?:\.[0-9]+)?|1(?:\.0+)?)$'),
    fees TEXT NOT NULL DEFAULT '0'
        CHECK (fees ~ '^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$'),

    theoretical_global_pnl TEXT
        CHECK (
            theoretical_global_pnl IS NULL
            OR theoretical_global_pnl ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$'
        ),
    opportunity_delta TEXT
        CHECK (
            opportunity_delta IS NULL
            OR opportunity_delta ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$'
        ),

    completed_at TIMESTAMPTZ NOT NULL,
    global_completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT user_position_outcome_reason_shape
        CHECK (
            length(terminal_reason) BETWEEN 1 AND 128
            AND terminal_reason = btrim(terminal_reason)
        ),

    CONSTRAINT user_position_outcome_owner_fk
        FOREIGN KEY (
            position_id,
            participation_id,
            user_id,
            signal_id
        )
        REFERENCES app.user_position (
            position_id,
            participation_id,
            user_id,
            signal_id
        )
        ON DELETE CASCADE
);

CREATE INDEX user_position_outcome_user_completed_idx
    ON app.user_position_outcome (
        user_id,
        completed_at DESC
    );

CREATE INDEX user_position_outcome_signal_idx
    ON app.user_position_outcome (signal_id);

COMMENT ON TABLE app.user_signal_participation IS
    'Application-owned authenticated user participation in a global DELTA signal.';

COMMENT ON TABLE app.user_trade_plan IS
    'Application-owned per-participation user trade plan. Decimal values are canonical strings.';

COMMENT ON TABLE app.user_balance_snapshot IS
    'Immutable planning-time account/balance observation. Contains no exchange credential secret.';

COMMENT ON TABLE app.user_position IS
    'Mutable current user-position snapshot; not the accounting ledger.';

COMMENT ON TABLE app.user_position_event IS
    'Append-oriented idempotent user action/accounting event ledger.';

COMMENT ON TABLE app.user_position_outcome IS
    'One terminal user outcome per position, separate from the global signal outcome.';
