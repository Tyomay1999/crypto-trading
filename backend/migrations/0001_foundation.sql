CREATE SCHEMA IF NOT EXISTS app;
CREATE SCHEMA IF NOT EXISTS auth;

CREATE TABLE IF NOT EXISTS app.system_metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO app.system_metadata (key, value)
VALUES ('schema_foundation', 'v1')
ON CONFLICT (key) DO NOTHING;
