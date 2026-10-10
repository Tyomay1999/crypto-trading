-- DELTA Application Projection foundation.
--
-- Ownership boundary:
--   Aggregator / Simulator: WRITE projection.*
--   Node application:       READ projection.*
--   User/application state: app.* (not modified here)
--
-- Frozen Projection Contract v1 schema SHA256:
-- dbdd0af64715596f705f3dff74f368fd1815dc26e22f326ddba10b400fa9dfa1
--
-- Decimal domain values remain inside canonical JSON payloads and are not
-- projected into PostgreSQL floating-point / NUMERIC columns.
-- occurred_at / as_of are domain timestamps, not persistence timestamps.

CREATE SCHEMA IF NOT EXISTS projection;

CREATE TABLE projection.published_signals (
    signal_id TEXT PRIMARY KEY,
    contract_schema_sha256 TEXT NOT NULL
        DEFAULT 'dbdd0af64715596f705f3dff74f368fd1815dc26e22f326ddba10b400fa9dfa1',
    exchange TEXT NOT NULL,
    market TEXT NOT NULL,
    symbol TEXT NOT NULL,
    direction TEXT NOT NULL,
    published_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ,
    projection_payload JSONB NOT NULL,
    persisted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT published_signals_signal_id_nonempty
        CHECK (length(signal_id) BETWEEN 1 AND 128),
    CONSTRAINT published_signals_schema_hash_exact
        CHECK (
            contract_schema_sha256 =
            'dbdd0af64715596f705f3dff74f368fd1815dc26e22f326ddba10b400fa9dfa1'
        ),
    CONSTRAINT published_signals_direction_domain
        CHECK (direction IN ('LONG', 'SHORT')),
    CONSTRAINT published_signals_context_nonempty
        CHECK (
            length(exchange) BETWEEN 1 AND 64
            AND length(market) BETWEEN 1 AND 64
            AND length(symbol) BETWEEN 1 AND 64
        ),
    CONSTRAINT published_signals_payload_object
        CHECK (jsonb_typeof(projection_payload) = 'object'),
    CONSTRAINT published_signals_expiration_after_publish
        CHECK (expires_at IS NULL OR expires_at >= published_at)
);

CREATE INDEX published_signals_context_time_idx
    ON projection.published_signals (
        exchange,
        market,
        symbol,
        published_at DESC,
        signal_id
    );

CREATE TABLE projection.signal_current (
    signal_id TEXT PRIMARY KEY
        REFERENCES projection.published_signals(signal_id)
        ON DELETE CASCADE,
    lifecycle_state TEXT NOT NULL,
    sequence BIGINT NOT NULL,
    as_of TIMESTAMPTZ NOT NULL,
    terminal_at TIMESTAMPTZ,
    snapshot_payload JSONB NOT NULL,
    persisted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT signal_current_lifecycle_state_domain
        CHECK (
            lifecycle_state IN (
                'PUBLISHED',
                'WAITING_FOR_ENTRY',
                'ENTRY_REACHED',
                'TP1_REACHED',
                'TP2_REACHED',
                'TP3_REACHED',
                'STOP_REACHED'
            )
        ),
    CONSTRAINT signal_current_sequence_positive
        CHECK (sequence >= 1),
    CONSTRAINT signal_current_payload_object
        CHECK (jsonb_typeof(snapshot_payload) = 'object'),
    CONSTRAINT signal_current_terminal_state_consistency
        CHECK (
            (lifecycle_state IN ('TP3_REACHED', 'STOP_REACHED') AND terminal_at IS NOT NULL)
            OR
            (lifecycle_state NOT IN ('TP3_REACHED', 'STOP_REACHED') AND terminal_at IS NULL)
        ),
    CONSTRAINT signal_current_terminal_not_after_as_of
        CHECK (terminal_at IS NULL OR terminal_at <= as_of)
);

CREATE INDEX signal_current_state_as_of_idx
    ON projection.signal_current (
        lifecycle_state,
        as_of DESC,
        signal_id
    );

CREATE TABLE projection.signal_events (
    signal_id TEXT NOT NULL
        REFERENCES projection.published_signals(signal_id)
        ON DELETE CASCADE,
    sequence BIGINT NOT NULL,
    event_type TEXT NOT NULL,
    from_state TEXT,
    to_state TEXT NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL,
    event_payload JSONB NOT NULL,
    persisted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (signal_id, sequence),

    CONSTRAINT signal_events_sequence_positive
        CHECK (sequence >= 1),
    CONSTRAINT signal_events_event_type_nonempty
        CHECK (length(event_type) BETWEEN 1 AND 64),
    CONSTRAINT signal_events_from_state_domain
        CHECK (
            from_state IS NULL
            OR from_state IN (
                'PUBLISHED',
                'WAITING_FOR_ENTRY',
                'ENTRY_REACHED',
                'TP1_REACHED',
                'TP2_REACHED',
                'TP3_REACHED',
                'STOP_REACHED'
            )
        ),
    CONSTRAINT signal_events_to_state_domain
        CHECK (
            to_state IN (
                'PUBLISHED',
                'WAITING_FOR_ENTRY',
                'ENTRY_REACHED',
                'TP1_REACHED',
                'TP2_REACHED',
                'TP3_REACHED',
                'STOP_REACHED'
            )
        ),
    CONSTRAINT signal_events_payload_object
        CHECK (jsonb_typeof(event_payload) = 'object')
);

CREATE INDEX signal_events_occurred_at_idx
    ON projection.signal_events (
        occurred_at,
        signal_id,
        sequence
    );

CREATE INDEX signal_events_signal_time_idx
    ON projection.signal_events (
        signal_id,
        occurred_at,
        sequence
    );

CREATE TABLE projection.signal_outcomes (
    signal_id TEXT PRIMARY KEY
        REFERENCES projection.published_signals(signal_id)
        ON DELETE CASCADE,
    final_status TEXT NOT NULL,
    as_of TIMESTAMPTZ NOT NULL,
    outcome_payload JSONB NOT NULL,
    persisted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT signal_outcomes_final_status_domain
        CHECK (final_status IN ('STOP', 'TP3')),
    CONSTRAINT signal_outcomes_payload_object
        CHECK (jsonb_typeof(outcome_payload) = 'object')
);

CREATE INDEX signal_outcomes_status_as_of_idx
    ON projection.signal_outcomes (
        final_status,
        as_of DESC,
        signal_id
    );

COMMENT ON SCHEMA projection IS
    'Global DR-derived application projection. No user-specific state.';

COMMENT ON TABLE projection.published_signals IS
    'Published global signal identity/context plus frozen Projection Contract v1 payload.';

COMMENT ON TABLE projection.signal_current IS
    'Materialized current lifecycle snapshot for fast application reads.';

COMMENT ON TABLE projection.signal_events IS
    'Immutable-by-writer lifecycle timeline keyed by signal_id + sequence; occurred_at is domain event time.';

COMMENT ON TABLE projection.signal_outcomes IS
    'Terminal signal outcome, separate from current snapshot and immutable event timeline.';
