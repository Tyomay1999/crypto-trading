/*
 * Authentication credentials can appear in an HTTP
 * request target. Observability must never persist
 * those credential values.
 */

const REDACTED = "[REDACTED]";

/*
 * Better Auth password reset uses a credential
 * inside the URL path:
 *
 * /api/auth/reset-password/<token>
 */
const PASSWORD_RESET_PATH =
  /(\/api\/auth\/reset-password\/)[^/?#]+/gi;

const RECOVERY_PATH =
  /(\/api\/v1\/auth\/mfa\/recovery-codes)(?:[/?#].*)?$/gi;

/*
 * Keep names of sensitive query parameters for
 * diagnostics, but never their values.
 *
 * request-context currently removes query strings
 * before logging. This rule protects future callers
 * that may pass a complete request target.
 */
const SENSITIVE_QUERY_PARAMETER =
  /([?&](?:token|code|state|access_token|refresh_token)=)[^&#]*/gi;

export function redactSensitiveHttpTarget(
  target: string,
): string {
  return target
    .replace(
      RECOVERY_PATH,
      `$1/${REDACTED}`,
    )
    .replace(
      PASSWORD_RESET_PATH,
      `$1${REDACTED}`,
    )
    .replace(
      SENSITIVE_QUERY_PARAMETER,
      `$1${REDACTED}`,
    );
}
