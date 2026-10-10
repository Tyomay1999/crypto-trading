import type { ErrorRequestHandler, RequestHandler } from "express";
import { AppError } from "../errors/app-error.js";
import {
  logMfaSecurityAuditEvent,
  type MfaSecurityAction,
} from "../auth/mfa-security-audit.js";
import { getRequestId } from "./request-context.js";

export const RECOVERY_PREFIX = "/api/v1/auth/mfa/recovery-codes";
export const recoverySensitiveHeaders: RequestHandler = (
  request,
  response,
  next,
) => {
  response.set("Cache-Control", "no-store");
  response.set("Pragma", "no-cache");
  // Recovery audit correlation must not echo attacker-supplied security material.
  // This runs before requestContextMiddleware generates its request ID.
  delete request.headers["x-request-id"];
  const actions: Record<string, MfaSecurityAction> = {
    "/generate": "recovery_codes_generated",
    "/regenerate": "recovery_codes_regenerated",
    "/challenge/verify": "recovery_code_challenge_verified",
  };
  const action =
    request.method === "POST" ? actions[request.path.toLowerCase()] : undefined;
  if (action)
    response.on("finish", () =>
      logMfaSecurityAuditEvent(
        getRequestId(response),
        action,
        response.statusCode === 429
          ? "rate_limited"
          : response.statusCode < 300
            ? "success"
            : "rejected",
      ),
    );
  next();
};

export const recoveryErrorHandler: ErrorRequestHandler = (
  error: unknown,
  _request,
  response,
  _next,
) => {
  response.removeHeader("Set-Cookie");
  response.set("Cache-Control", "no-store");
  response.set("Pragma", "no-cache");
  const type =
    typeof error === "object" && error !== null && "type" in error
      ? error.type
      : null;
  const status =
    type === "entity.too.large"
      ? 413
      : type === "entity.parse.failed"
        ? 400
        : error instanceof AppError &&
            [400, 401, 403, 404, 409, 429].includes(error.statusCode)
          ? error.statusCode
          : 500;
  // Neither error.message nor arbitrary error.code is safe to reflect or log.
  const codes: Record<number, string> = {
    400: "INVALID_RECOVERY_REQUEST",
    401: "RECOVERY_REQUEST_REJECTED",
    403: "RECOVERY_ORIGIN_REJECTED",
    404: "RECOVERY_ROUTE_NOT_FOUND",
    409: "RECOVERY_STATE_CONFLICT",
    413: "RECOVERY_BODY_TOO_LARGE",
    429: "RECOVERY_RATE_LIMITED",
    500: "RECOVERY_UNAVAILABLE",
  };
  response.status(status).json({
    error: {
      code: codes[status],
      message: "Recovery request could not be completed.",
      requestId: getRequestId(response),
    },
  });
};
