-- Delta A3 multi-device session management.
--
-- Better Auth remains the authority for session validity,
-- ownership, expiry, token storage, IP address and User-Agent.
--
-- Delta stores only coarse application activity needed to
-- expose an honest lastActivityAt value without modifying
-- Better Auth-owned auth.session rows on every API request.

CREATE TABLE app.auth_session_activity (
    session_id TEXT PRIMARY KEY
        REFERENCES auth."session" ("id")
        ON DELETE CASCADE,
    last_activity_at TIMESTAMPTZ NOT NULL
);
