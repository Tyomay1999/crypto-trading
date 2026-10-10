import { isIP } from "node:net";
import type { RequestHandler } from "express";
import type { Pool } from "pg";
import { AppError } from "../errors/app-error.js";
import {
  takeRecoveryRateLimit,
  type RecoveryLimitScope,
} from "../storage/recovery-rate-limit.js";

export function recoveryIpRateLimit(
  database: Pick<Pool, "query">,
  pepper: string,
  scope: RecoveryLimitScope,
): RequestHandler {
  return async (request, _response, next) => {
    // Same accepted boundary as Better Auth: the reverse proxy overwrites X-Real-IP.
    // No forwarded-chain parsing and no fallback to attacker-supplied headers.
    const ip = request.get("x-real-ip");
    if (!ip || isIP(ip) === 0)
      throw new AppError(
        400,
        "INVALID_RECOVERY_REQUEST",
        "Recovery request rejected.",
      );
    // IPv6 equivalent spellings must not multiply buckets.
    const canonical =
      isIP(ip) === 6 ? new URL(`http://[${ip}]/`).hostname.toLowerCase() : ip;
    if (!(await takeRecoveryRateLimit(database, pepper, scope, canonical))) {
      throw new AppError(
        429,
        "RECOVERY_RATE_LIMITED",
        "Recovery request rejected.",
      );
    }
    next();
  };
}
