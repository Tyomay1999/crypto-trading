-- DELTA U5: enrich the app-owned current user position snapshot with exact
-- accounting state and stop-progression basis. No auth.* or projection.* DDL.

ALTER TABLE app.user_position
    ADD COLUMN direction TEXT,
    ADD COLUMN realized_fraction TEXT NOT NULL DEFAULT '0',
    ADD COLUMN realized_pnl TEXT NOT NULL DEFAULT '0',
    ADD COLUMN stop_basis TEXT NOT NULL DEFAULT 'ORIGINAL';

ALTER TABLE app.user_position
    ADD CONSTRAINT user_position_direction_shape
    CHECK (
        direction IS NULL
        OR direction IN ('LONG', 'SHORT')
    ),
    ADD CONSTRAINT user_position_realized_fraction_shape
    CHECK (
        realized_fraction ~ '^(?:0(?:\.[0-9]+)?|1(?:\.0+)?)$'
    ),
    ADD CONSTRAINT user_position_realized_pnl_shape
    CHECK (
        realized_pnl ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$'
    ),
    ADD CONSTRAINT user_position_stop_basis_shape
    CHECK (
        stop_basis IN ('ORIGINAL', 'ENTRY', 'TP1', 'TP2')
    ),
    ADD CONSTRAINT user_position_fraction_conservation
    CHECK (
        remaining_fraction ~ '^(?:0(?:\.[0-9]+)?|1(?:\.0+)?)$'
        AND realized_fraction ~ '^(?:0(?:\.[0-9]+)?|1(?:\.0+)?)$'
    );

COMMENT ON COLUMN app.user_position.direction IS
    'Immutable position direction copied from global signal at user entry.';
COMMENT ON COLUMN app.user_position.realized_fraction IS
    'Cumulative fraction already realized from the initial position.';
COMMENT ON COLUMN app.user_position.realized_pnl IS
    'Cumulative realized P&L as canonical signed decimal text.';
COMMENT ON COLUMN app.user_position.stop_basis IS
    'Current user stop progression basis: ORIGINAL, ENTRY, TP1, or TP2.';
