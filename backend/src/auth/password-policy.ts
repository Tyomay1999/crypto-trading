/*
 * Delta password policy follows current
 * passphrase-oriented guidance:
 *
 * - length is the primary user-facing control;
 * - no arbitrary character-class composition rules;
 * - passwords are never silently truncated.
 *
 * MFA/passkeys are introduced in later auth stages.
 */
export const AUTH_PASSWORD_MIN_LENGTH = 15;
export const AUTH_PASSWORD_MAX_LENGTH = 128;
