-- DELTA U4: preserve the evidence used to produce a user trade recommendation.
-- No auth/security or projection object is modified.

ALTER TABLE app.user_balance_snapshot
    ADD CONSTRAINT user_balance_snapshot_owner_key
    UNIQUE (balance_snapshot_id, participation_id, user_id, signal_id);

ALTER TABLE app.user_trade_plan
    ADD COLUMN balance_snapshot_id TEXT,
    ADD COLUMN suggested_leverage TEXT,
    ADD COLUMN required_margin TEXT;

ALTER TABLE app.user_trade_plan
    ADD CONSTRAINT user_trade_plan_recommendation_evidence_shape
    CHECK (
        (
            balance_snapshot_id IS NULL
            AND suggested_leverage IS NULL
            AND required_margin IS NULL
        )
        OR
        (
            balance_snapshot_id IS NOT NULL
            AND suggested_leverage IS NOT NULL
            AND required_margin IS NOT NULL
        )
    ),
    ADD CONSTRAINT user_trade_plan_suggested_leverage_shape
    CHECK (
        suggested_leverage IS NULL
        OR suggested_leverage ~ '^[1-9][0-9]*$'
    ),
    ADD CONSTRAINT user_trade_plan_required_margin_shape
    CHECK (
        required_margin IS NULL
        OR required_margin ~ '^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$'
    ),
    ADD CONSTRAINT user_trade_plan_balance_snapshot_owner_fk
    FOREIGN KEY (
        balance_snapshot_id,
        participation_id,
        user_id,
        signal_id
    )
    REFERENCES app.user_balance_snapshot (
        balance_snapshot_id,
        participation_id,
        user_id,
        signal_id
    )
    ON DELETE RESTRICT;

COMMENT ON COLUMN app.user_trade_plan.balance_snapshot_id IS
    'Immutable account snapshot used when this recommendation/selection was calculated.';

COMMENT ON COLUMN app.user_trade_plan.suggested_leverage IS
    'DELTA-recommended integer leverage, persisted as canonical decimal text.';

COMMENT ON COLUMN app.user_trade_plan.required_margin IS
    'Required margin for the selected notional/leverage, canonical decimal text.';
