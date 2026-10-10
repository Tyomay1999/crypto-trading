-- Delta A4-C WebAuthn / passkey storage foundation.
--
-- Better Auth owns the credential model contract. Delta owns this migration,
-- the stronger credential/counter constraints, method provenance and durable
-- rate-limit storage. WebAuthn challenges remain in auth."verification".

CREATE TABLE auth."passkey" (
    "id" TEXT PRIMARY KEY,
    "name" TEXT,
    "publicKey" TEXT NOT NULL
        CONSTRAINT "passkey_publicKey_nonempty"
        CHECK (length("publicKey") > 0),
    "userId" TEXT NOT NULL
        REFERENCES auth."user" ("id")
        ON DELETE CASCADE,
    "credentialID" TEXT NOT NULL,
    "counter" BIGINT NOT NULL,
    "deviceType" TEXT NOT NULL,
    "backedUp" BOOLEAN NOT NULL,
    "transports" TEXT,
    "createdAt" TIMESTAMPTZ,
    "aaguid" TEXT,

    CONSTRAINT "passkey_credentialID_key"
        UNIQUE ("credentialID"),
    CONSTRAINT "passkey_credentialID_base64url"
        CHECK ("credentialID" ~ '^[A-Za-z0-9_-]+$'),
    CONSTRAINT "passkey_counter_uint32"
        CHECK ("counter" BETWEEN 0 AND 4294967295),
    CONSTRAINT "passkey_deviceType_values"
        CHECK ("deviceType" IN ('singleDevice', 'multiDevice'))
);

CREATE INDEX "passkey_userId_idx"
    ON auth."passkey" ("userId");

-- Method-specific provenance only. This marker does not grant a generalized
-- assurance level. Credential deletion retains the session method snapshot.
CREATE TABLE app.auth_passkey_session_marker (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL UNIQUE
        REFERENCES auth."session" ("id")
        ON DELETE CASCADE,
    passkey_id TEXT
        REFERENCES auth."passkey" ("id")
        ON DELETE SET NULL,
    user_verified BOOLEAN NOT NULL
        CONSTRAINT auth_passkey_session_marker_uv_true
        CHECK (user_verified = TRUE),
    credential_device_type TEXT NOT NULL
        CONSTRAINT auth_passkey_session_marker_device_type
        CHECK (credential_device_type IN ('singleDevice', 'multiDevice')),
    credential_backed_up BOOLEAN NOT NULL,
    authenticated_at TIMESTAMPTZ NOT NULL,
    aaguid TEXT,
    transports TEXT
);

-- Full keyed HMAC-SHA-256 identities keep raw client/account/credential data
-- out of durable rate-limit storage. Hits are capped by the storage contract.
CREATE TABLE app.auth_passkey_rate_limit (
    id TEXT PRIMARY KEY CHECK (id ~ '^[0-9a-f]{64}$'),
    hits INTEGER NOT NULL CHECK (hits BETWEEN 1 AND 60),
    expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX auth_passkey_rate_limit_expiry_idx
    ON app.auth_passkey_rate_limit (expires_at);
