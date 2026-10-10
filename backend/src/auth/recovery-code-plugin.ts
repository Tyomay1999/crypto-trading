import { APIError, type BetterAuthPlugin } from "better-auth";
import { createAuthEndpoint, getSessionFromCtx } from "better-auth/api";
import type { Pool } from "pg";
import type { AuthEnvironment } from "./config.js";
import {
  AUTH_PASSWORD_MAX_LENGTH,
  AUTH_PASSWORD_MIN_LENGTH,
} from "./password-policy.js";
import { normalizeRecoveryCode } from "./recovery-codes.js";
import {
  verifyRecoveryChallenge,
  type RecoveryEndpointContext,
} from "./recovery-challenge.js";
import {
  claimRecoveryManagementProof,
  findRecoverySet,
  recoveryStatus,
  replaceRecoveryCodes,
} from "../storage/recovery-codes.js";
import { takeRecoveryRateLimit } from "../storage/recovery-rate-limit.js";

const field = (type: "string" | "date" | "number", fieldName: string) => ({
  type,
  fieldName,
  required: true,
  input: false,
  returned: false,
});
export const recoverySchema = {
  recoveryCodeSet: {
    modelName: "app.auth_recovery_code_set",
    disableMigration: true,
    fields: {
      userId: {
        ...field("string", "user_id"),
        unique: true,
        references: {
          model: "user",
          field: "id",
          onDelete: "cascade" as const,
        },
      },
      generation: field("string", "generation"),
      createdAt: field("date", "created_at"),
      updatedAt: field("date", "updated_at"),
    },
  },
  recoveryCode: {
    modelName: "app.auth_recovery_code",
    disableMigration: true,
    fields: {
      setId: {
        ...field("string", "set_id"),
        references: {
          model: "recoveryCodeSet",
          field: "id",
          onDelete: "cascade" as const,
        },
      },
      generation: field("string", "generation"),
      codeDigest: field("string", "code_digest"),
    },
  },
  recoverySessionMarker: {
    modelName: "app.auth_recovery_session_marker",
    disableMigration: true,
    fields: {
      sessionId: {
        ...field("string", "session_id"),
        unique: true,
        references: {
          model: "session",
          field: "id",
          onDelete: "cascade" as const,
        },
      },
      authenticatedAt: field("date", "authenticated_at"),
    },
  },
  recoveryRateLimit: {
    modelName: "app.auth_recovery_rate_limit",
    disableMigration: true,
    fields: {
      hits: field("number", "hits"),
      expiresAt: field("date", "expires_at"),
    },
  },
} satisfies NonNullable<BetterAuthPlugin["schema"]>;

function reject(
  status: "BAD_REQUEST" | "UNAUTHORIZED" | "CONFLICT" | "TOO_MANY_REQUESTS",
  code: string,
): never {
  throw new APIError(status, { code, message: "Recovery request rejected." });
}

export function enforceRecoveryChallengeOutcome(
  outcome: Awaited<ReturnType<typeof verifyRecoveryChallenge>>,
): void {
  if (outcome === "account_locked")
    reject("TOO_MANY_REQUESTS", "RECOVERY_ACCOUNT_LOCKED");
  if (outcome !== "verified")
    reject("UNAUTHORIZED", "RECOVERY_CHALLENGE_REJECTED");
}

export function parseRecoveryBody(
  body: unknown,
  management: boolean,
): { code: string; password: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body))
    reject("BAD_REQUEST", "INVALID_RECOVERY_REQUEST");
  const value = body as Record<string, unknown>;
  const keys = Object.keys(value);
  if (
    keys.length !== (management ? 2 : 1) ||
    !keys.includes("code") ||
    (management && !keys.includes("password")) ||
    typeof value.code !== "string" ||
    (management
      ? !/^[0-9]{6}$/.test(value.code)
      : normalizeRecoveryCode(value.code) === null) ||
    (management &&
      (typeof value.password !== "string" ||
        value.password.length < AUTH_PASSWORD_MIN_LENGTH ||
        value.password.length > AUTH_PASSWORD_MAX_LENGTH))
  ) {
    reject("BAD_REQUEST", "INVALID_RECOVERY_REQUEST");
  }
  return {
    code: value.code as string,
    password: management ? (value.password as string) : "",
  };
}

export function recoveryCodePlugin(database: Pool, env: AuthEnvironment) {
  const safe = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof APIError) throw error;
      // Never allow a driver error (which may contain parameter details) into Better Auth logs.
      throw new APIError("INTERNAL_SERVER_ERROR", {
        code: "RECOVERY_UNAVAILABLE",
        message: "Recovery request unavailable.",
      });
    }
  };
  const manage = async (ctx: RecoveryEndpointContext, regenerate: boolean) => {
    const body = parseRecoveryBody(ctx.body, true);
    const session = await getSessionFromCtx(ctx, {
      disableCookieCache: true,
      disableRefresh: true,
    });
    if (!session) reject("UNAUTHORIZED", "AUTHENTICATION_REQUIRED");
    if (
      !(await takeRecoveryRateLimit(
        database,
        env.recoveryPepper,
        "mutationUser",
        session.user.id,
      ))
    )
      reject("TOO_MANY_REQUESTS", "RECOVERY_RATE_LIMITED");
    // Captured internally before proof work; clients never supply a generation.
    const observed = await findRecoverySet(
      ctx.context.adapter,
      session.user.id,
    );
    if (regenerate ? !observed : !!observed)
      reject(
        "CONFLICT",
        regenerate ? "RECOVERY_NOT_CONFIGURED" : "RECOVERY_ALREADY_CONFIGURED",
      );
    const proof = await claimRecoveryManagementProof(
      database,
      {
        userId: session.user.id,
        sessionId: session.session.id,
        password: body.password,
        code: body.code,
        encryptionKey: env.secret,
        replayPepper: env.replayPepper,
      },
      ctx.context.password.verify,
    );
    if (!proof) reject("UNAUTHORIZED", "RECOVERY_PROOF_REJECTED");
    const result = await replaceRecoveryCodes(
      ctx.context.adapter,
      proof,
      observed?.generation ?? null,
      env.recoveryPepper,
      { encryptionKey: env.secret, code: body.code },
    );
    if (!result) reject("CONFLICT", "RECOVERY_STATE_CHANGED");
    return ctx.json(result);
  };
  return {
    id: "delta-recovery-codes",
    schema: recoverySchema,
    endpoints: {
      deltaRecoveryStatus: createAuthEndpoint(
        "/delta-recovery/status",
        { method: "GET" },
        (ctx) =>
          safe(async () => {
            const session = await getSessionFromCtx(ctx, {
              disableCookieCache: true,
              disableRefresh: true,
            });
            if (!session) reject("UNAUTHORIZED", "AUTHENTICATION_REQUIRED");
            return ctx.json(
              await recoveryStatus(ctx.context.adapter, session.user.id),
            );
          }),
      ),
      deltaRecoveryGenerate: createAuthEndpoint(
        "/delta-recovery/generate",
        { method: "POST" },
        (ctx) => safe(() => manage(ctx, false)),
      ),
      deltaRecoveryRegenerate: createAuthEndpoint(
        "/delta-recovery/regenerate",
        { method: "POST" },
        (ctx) => safe(() => manage(ctx, true)),
      ),
      deltaRecoveryVerify: createAuthEndpoint(
        "/delta-recovery/verify",
        { method: "POST" },
        (ctx) =>
          safe(async () => {
            const { code } = parseRecoveryBody(ctx.body, false);
            const outcome = await verifyRecoveryChallenge(
              ctx,
              env.recoveryPepper,
              code,
            );
            enforceRecoveryChallengeOutcome(outcome);
            return ctx.json({ status: true });
          }),
      ),
    },
  } satisfies BetterAuthPlugin;
}
