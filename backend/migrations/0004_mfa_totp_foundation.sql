-- Delta A4 MFA / strong-auth foundation.
--
-- auth.* is Better Auth-owned schema.
-- app.* is Delta-owned auxiliary security state.
--
-- The Better Auth twoFactor backupCodes field does
-- not contain real Delta recovery credentials.
-- Delta recovery credentials are introduced later
-- as hash-only app-owned state.

ALTER TABLE auth."user"
    ADD COLUMN "twoFactorEnabled"
        BOOLEAN DEFAULT FALSE;

CREATE TABLE auth."twoFactor" (
    "id" TEXT PRIMARY KEY,

    "secret" TEXT NOT NULL,

    "backupCodes" TEXT NOT NULL,

    "userId" TEXT NOT NULL
        REFERENCES auth."user" ("id")
        ON DELETE CASCADE,

    "verified" BOOLEAN
        DEFAULT TRUE,

    "failedVerificationCount" INTEGER
        DEFAULT 0,

    "lockedUntil" TIMESTAMPTZ
);

-- Better Auth 1.7.3 plugin schema declares both
-- secret and userId as indexed fields.
CREATE INDEX "twoFactor_secret_idx"
    ON auth."twoFactor" ("secret");

-- Better Auth's current TOTP runtime resolves
-- one factor row by userId. Enforce that security
-- invariant durably so concurrent enrollment cannot
-- create ambiguous duplicate factor records.
CREATE UNIQUE INDEX "twoFactor_userId_key"
    ON auth."twoFactor" ("userId");

-- Delta-owned durable TOTP replay state.
--
-- code_digest will contain a keyed HMAC digest,
-- never the six-digit TOTP code itself.
CREATE TABLE app.auth_totp_replay_guard (
    user_id TEXT NOT NULL
        REFERENCES auth."user" ("id")
        ON DELETE CASCADE,

    code_digest TEXT NOT NULL,

    accepted_at TIMESTAMPTZ NOT NULL,

    expires_at TIMESTAMPTZ NOT NULL,

    PRIMARY KEY (
        user_id,
        code_digest
    ),

    CONSTRAINT auth_totp_replay_guard_digest_length
        CHECK (
            length(code_digest) = 64
        ),

    CONSTRAINT auth_totp_replay_guard_expiry_order
        CHECK (
            expires_at > accepted_at
        )
);

CREATE INDEX auth_totp_replay_guard_expires_at_idx
    ON app.auth_totp_replay_guard (
        expires_at
    );

-- Delta-owned staged TOTP replacement.
--
-- The existing verified Better Auth factor remains
-- authoritative until the pending replacement is
-- successfully verified and atomically swapped.
CREATE TABLE app.auth_totp_replacement (
    user_id TEXT PRIMARY KEY
        REFERENCES auth."user" ("id")
        ON DELETE CASCADE,

    replacement_id TEXT NOT NULL UNIQUE,

    encrypted_secret TEXT NOT NULL,

    failed_verification_count INTEGER NOT NULL
        DEFAULT 0,

    created_at TIMESTAMPTZ NOT NULL,

    expires_at TIMESTAMPTZ NOT NULL,

    CONSTRAINT auth_totp_replacement_id_length
        CHECK (
            length(replacement_id)
                BETWEEN 24 AND 128
        ),

    CONSTRAINT auth_totp_replacement_secret_nonempty
        CHECK (
            length(encrypted_secret) > 0
        ),

    CONSTRAINT auth_totp_replacement_failed_count_nonnegative
        CHECK (
            failed_verification_count >= 0
        ),

    CONSTRAINT auth_totp_replacement_expiry_order
        CHECK (
            expires_at > created_at
        )
);

CREATE INDEX auth_totp_replacement_expires_at_idx
    ON app.auth_totp_replacement (expires_at);

