-- Manually owned by Delta. Better Auth plugin models disableMigration=true.
CREATE TABLE app.auth_recovery_code_set (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL UNIQUE REFERENCES auth."user"("id") ON DELETE CASCADE,
    generation TEXT NOT NULL CHECK (length(generation) = 36),
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    UNIQUE (id, generation)
);

CREATE TABLE app.auth_recovery_code (
    id TEXT PRIMARY KEY,
    set_id TEXT NOT NULL,
    generation TEXT NOT NULL,
    code_digest BYTEA NOT NULL CHECK (octet_length(code_digest) = 32),
    FOREIGN KEY (set_id, generation)
        REFERENCES app.auth_recovery_code_set(id, generation) ON DELETE CASCADE,
    UNIQUE (set_id, generation, code_digest)
);

-- Provenance only; this marker does not grant strong MFA assurance.
CREATE TABLE app.auth_recovery_session_marker (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL UNIQUE REFERENCES auth."session"("id") ON DELETE CASCADE,
    authenticated_at TIMESTAMPTZ NOT NULL
);

-- Full keyed HMAC-SHA-256 identities prevent unrelated clients from sharing budgets.
-- Expiry indexing and bounded opportunistic cleanup control stale-row storage.
CREATE TABLE app.auth_recovery_rate_limit (
    id TEXT PRIMARY KEY CHECK (id ~ '^[0-9a-f]{64}$'),
    hits INTEGER NOT NULL CHECK (hits BETWEEN 1 AND 60),
    expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX auth_recovery_rate_limit_expiry_idx
    ON app.auth_recovery_rate_limit(expires_at);
