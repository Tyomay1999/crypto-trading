import {
  Router,
  type Request,
  type Response as ExpressResponse,
} from "express";
import { fromNodeHeaders } from "better-auth/node";
import type { Pool } from "pg";
import type { DeltaAuth } from "../auth/core.js";
import { normalizeRecoveryCode } from "../auth/recovery-codes.js";
import { AppError } from "../errors/app-error.js";
import { createRequireTrustedOriginMiddleware } from "../middleware/require-trusted-origin.js";
import { recoveryIpRateLimit } from "../middleware/recovery-rate-limit.js";

export type RecoveryRoutesDependencies = {
  auth: DeltaAuth;
  database: Pick<Pool, "query">;
  trustedOrigins: readonly string[];
  recoveryPepper: string;
};

export function createRecoveryRouter(deps: RecoveryRoutesDependencies) {
  const router = Router();
  const origin = createRequireTrustedOriginMiddleware(deps.trustedOrigins);
  const rate = (scope: "statusIp" | "mutationIp" | "challengeIp") =>
    recoveryIpRateLimit(deps.database, deps.recoveryPepper, scope);
  const respond = async (
    request: Request,
    response: ExpressResponse,
    operation: "status" | "generate" | "regenerate" | "verify",
  ) => {
    const headers = fromNodeHeaders(request.headers);
    let result: Response;
    try {
      if (operation === "status")
        result = await deps.auth.api.deltaRecoveryStatus({
          headers,
          asResponse: true,
        });
      else {
        const input = {
          headers,
          body: request.body,
          asResponse: true as const,
        };
        if (operation === "generate")
          result = await deps.auth.api.deltaRecoveryGenerate(input);
        else if (operation === "regenerate")
          result = await deps.auth.api.deltaRecoveryRegenerate(input);
        else result = await deps.auth.api.deltaRecoveryVerify(input);
      }
    } catch {
      throw new AppError(
        500,
        "RECOVERY_UNAVAILABLE",
        "Recovery request unavailable.",
      );
    }
    if (!result.ok) {
      // Never forward cookies or untrusted Better Auth JSON from any failure.
      throw new AppError(
        [400, 401, 403, 409, 429].includes(result.status) ? result.status : 500,
        "RECOVERY_REQUEST_REJECTED",
        "Recovery request rejected.",
      );
    }
    const value: unknown = await result.json();
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw new Error("Invalid recovery response.");
    const data = value as Record<string, unknown>;
    if (operation === "status") {
      if (
        Object.keys(data).length !== 2 ||
        typeof data.configured !== "boolean" ||
        !Number.isInteger(data.remaining) ||
        (data.remaining as number) < 0 ||
        (data.remaining as number) > 10
      )
        throw new Error("Invalid recovery status.");
      response.json({ configured: data.configured, remaining: data.remaining });
    } else if (operation === "verify") {
      if (Object.keys(data).length !== 1 || data.status !== true)
        throw new Error("Invalid recovery authentication response.");
      const cookies = result.headers.getSetCookie();
      const sessionCookies = cookies.filter((cookie) =>
        /^(?:__Secure-)?delta-auth\.session_token=[^;]/.test(cookie),
      );
      if (
        sessionCookies.length !== 1 ||
        cookies.some((cookie) => /trust_device/i.test(cookie))
      )
        throw new Error("Invalid recovery authentication cookies.");
      // Validate the entire result before releasing any committed authentication cookie.
      for (const cookie of cookies) response.append("Set-Cookie", cookie);
      response.json({ status: true });
    } else {
      if (
        Object.keys(data).length !== 1 ||
        !Array.isArray(data.codes) ||
        data.codes.length !== 10 ||
        new Set(data.codes).size !== 10 ||
        !data.codes.every((code) => normalizeRecoveryCode(code) !== null)
      )
        throw new Error("Invalid recovery generation response.");
      response.json({ codes: data.codes });
    }
  };
  router.get("/status", rate("statusIp"), (req, res) =>
    respond(req, res, "status"),
  );
  router.post("/generate", origin, rate("mutationIp"), (req, res) =>
    respond(req, res, "generate"),
  );
  router.post("/regenerate", origin, rate("mutationIp"), (req, res) =>
    respond(req, res, "regenerate"),
  );
  router.post("/challenge/verify", origin, rate("challengeIp"), (req, res) =>
    respond(req, res, "verify"),
  );
  router.use(() => {
    throw new AppError(
      404,
      "RECOVERY_ROUTE_NOT_FOUND",
      "Recovery route not found.",
    );
  });
  return router;
}
