export type MfaSecurityAction =
  | "totp_enrollment_started"
  | "totp_enrollment_verified"
  | "totp_login_challenge_verified"
  | "totp_replacement_started"
  | "totp_replaced"
  | "totp_disabled"
  | "recovery_codes_generated"
  | "recovery_codes_regenerated"
  | "recovery_code_challenge_verified"
  | PasskeySecurityAction;

export type MfaSecurityOutcome =
  | "success"
  | "rejected"
  | "replay_rejected"
  | "rate_limited"
  | "conflict"
  | "internal_failure";

export const PASSKEY_SECURITY_ACTIONS = [
  "passkey_registration",
  "passkey_authentication",
  "passkey_management_fresh_proof",
  "passkey_management_list",
  "passkey_management_rename",
  "passkey_management_delete",
  "passkey_rate_limit",
  "passkey_security_failure",
] as const;

export type PasskeySecurityAction =
  (typeof PASSKEY_SECURITY_ACTIONS)[number];

export const PASSKEY_SAFE_REASON_CODES = [
  "credential_rejected",
  "rate_limited",
  "fresh_proof_rejected",
  "duplicate_credential",
  "internal_failure",
] as const;

export type PasskeySafeReasonCode =
  (typeof PASSKEY_SAFE_REASON_CODES)[number];

export type PasskeyAuditMetadata = Readonly<{
  authMethod: "passkey";
  reason?: PasskeySafeReasonCode;
  userVerified?: boolean;
  credentialDeviceType?: "singleDevice" | "multiDevice";
  credentialBackedUp?: boolean;
}>;

const MFA_SECURITY_ACTIONS = new Set<MfaSecurityAction>([
  "totp_enrollment_started",
  "totp_enrollment_verified",
  "totp_login_challenge_verified",
  "totp_replacement_started",
  "totp_replaced",
  "totp_disabled",
  "recovery_codes_generated",
  "recovery_codes_regenerated",
  "recovery_code_challenge_verified",
  ...PASSKEY_SECURITY_ACTIONS,
]);

const MFA_SECURITY_OUTCOMES = new Set<MfaSecurityOutcome>([
  "success",
  "rejected",
  "replay_rejected",
  "rate_limited",
  "conflict",
  "internal_failure",
]);

export function sanitizePasskeyAuditMetadata(
  input: unknown,
): PasskeyAuditMetadata {
  const output: {
    authMethod: "passkey";
    reason?: PasskeySafeReasonCode;
    userVerified?: boolean;
    credentialDeviceType?: "singleDevice" | "multiDevice";
    credentialBackedUp?: boolean;
  } = { authMethod: "passkey" };
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return Object.freeze(output);
  }
  const candidate = input as Record<string, unknown>;
  if (
    typeof candidate.reason === "string" &&
    PASSKEY_SAFE_REASON_CODES.includes(
      candidate.reason as PasskeySafeReasonCode,
    )
  ) {
    output.reason = candidate.reason as PasskeySafeReasonCode;
  }
  if (typeof candidate.userVerified === "boolean") {
    output.userVerified = candidate.userVerified;
  }
  if (
    candidate.credentialDeviceType === "singleDevice" ||
    candidate.credentialDeviceType === "multiDevice"
  ) {
    output.credentialDeviceType = candidate.credentialDeviceType;
  }
  if (typeof candidate.credentialBackedUp === "boolean") {
    output.credentialBackedUp = candidate.credentialBackedUp;
  }
  return Object.freeze(output);
}

export function logMfaSecurityAuditEvent(
  requestId: string,
  action: MfaSecurityAction,
  outcome: MfaSecurityOutcome,
): void {
  if (!MFA_SECURITY_ACTIONS.has(action) || !MFA_SECURITY_OUTCOMES.has(outcome)) {
    throw new Error("Invalid MFA security audit event.");
  }
  console.log(
    JSON.stringify({
      event:
        "auth_mfa_security_event",

      requestId,
      action,
      outcome,
    }),
  );
}

export function logPasskeySecurityAuditEvent(
  requestId: string,
  action: PasskeySecurityAction,
  outcome: MfaSecurityOutcome,
  metadata: unknown,
): void {
  if (!PASSKEY_SECURITY_ACTIONS.includes(action)) {
    throw new Error("Invalid passkey security audit action.");
  }
  const safe = sanitizePasskeyAuditMetadata(metadata);
  if (!MFA_SECURITY_OUTCOMES.has(outcome)) {
    throw new Error("Invalid passkey security audit outcome.");
  }
  console.log(
    JSON.stringify({
      event: "auth_mfa_security_event",
      requestId,
      action,
      outcome,
      ...safe,
    }),
  );
}

export function tryLogPasskeySecurityAuditEvent(
  requestId: string,
  action: PasskeySecurityAction,
  outcome: MfaSecurityOutcome,
  metadata: unknown,
): void {
  try {
    logPasskeySecurityAuditEvent(requestId, action, outcome, metadata);
  } catch {
    // Existing audit delivery is non-authoritative to authentication state.
  }
}
