export type SessionSecurityAuditAction =
  | "revoke_other_session"
  | "logout_current"
  | "logout_everywhere";

export interface SessionSecurityAuditEvent {
  event:
    "auth_session_security_event";
  requestId:
    string;
  action:
    SessionSecurityAuditAction;
  outcome:
    "success";
}

export function createSessionSecurityAuditEvent(
  requestId:
    string,
  action:
    SessionSecurityAuditAction,
): SessionSecurityAuditEvent {
  return {
    event:
      "auth_session_security_event",
    requestId,
    action,
    outcome:
      "success",
  };
}

export function logSessionSecurityAuditEvent(
  requestId:
    string,
  action:
    SessionSecurityAuditAction,
): void {
  console.log(
    JSON.stringify(
      createSessionSecurityAuditEvent(
        requestId,
        action,
      ),
    ),
  );
}
