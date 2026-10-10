-- Delta A2 email-verification one-time-use guard.
--
-- Better Auth 1.7.3 email verification tokens are
-- stateless signed JWTs. Delta stores only a
-- domain-separated SHA-256 digest after a valid
-- token is first presented.
--
-- The plaintext token and email address are never
-- persisted in this table.

CREATE TABLE app.auth_email_verification_replay_guard (
    user_id TEXT NOT NULL
        REFERENCES auth."user" ("id")
        ON DELETE CASCADE,

    token_digest TEXT NOT NULL,

    accepted_at TIMESTAMPTZ NOT NULL,

    expires_at TIMESTAMPTZ NOT NULL,

    PRIMARY KEY (
        user_id,
        token_digest
    ),

    CONSTRAINT auth_email_verification_replay_digest_length
        CHECK (
            length(token_digest) = 64
        ),

    CONSTRAINT auth_email_verification_replay_digest_format
        CHECK (
            token_digest ~ '^[0-9a-f]{64}$'
        ),

    CONSTRAINT auth_email_verification_replay_expiry_order
        CHECK (
            expires_at > accepted_at
        )
);

CREATE INDEX auth_email_verification_replay_expires_at_idx
    ON app.auth_email_verification_replay_guard (
        expires_at
    );

CREATE INDEX auth_email_verification_replay_user_id_idx
    ON app.auth_email_verification_replay_guard (
        user_id
    );
