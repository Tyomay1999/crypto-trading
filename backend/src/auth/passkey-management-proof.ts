import type { GenericEndpointContext } from "@better-auth/core";

import {
  AUTH_PASSWORD_MAX_LENGTH,
  AUTH_PASSWORD_MIN_LENGTH,
} from "./password-policy.js";
import { createTotpReplayDigest } from "./totp-replay.js";
import {
  isValidTotpCode,
  verifyEncryptedTotpCode,
} from "./totp-replacement.js";

const FRESH_PROOF_MAX_AGE_MS = 30_000;
const TOTP_REPLAY_HORIZON_MS = 5 * 60 * 1_000;
const trustedContext = Symbol("delta.passkey.management.trusted-origin");

type BetterAuthPasswordVerify =
  GenericEndpointContext["context"]["password"]["verify"];

export type PasskeyManagementSecurityState = Readonly<{
  sessionValid: boolean;
  passwordHash: string | null;
  totp:
    | Readonly<{ state: "absent" }>
    | Readonly<{
        state: "active";
        encryptedSecret: string;
        lockedUntil: Date | null;
      }>
    | Readonly<{ state: "inconsistent" }>;
}>;

export type TrustedPasskeyManagementContext = Readonly<{
  userId: string;
  sessionId: string;
  [trustedContext]: true;
}>;

export type PasskeyManagementFreshProof = Readonly<{
  userId: string;
  sessionId: string;
  acceptedAt: Date;
  methods: readonly ("password" | "totp")[];
}>;

export type PasskeyManagementProofDependencies = Readonly<{
  loadSecurityState: (
    context: Readonly<{ userId: string; sessionId: string; observedAt: Date }>,
  ) => Promise<PasskeyManagementSecurityState>;
  verifyPassword: BetterAuthPasswordVerify;
  claimTotpReplay: (input: Readonly<{
    userId: string;
    codeDigest: string;
    acceptedAt: Date;
    expiresAt: Date;
  }>) => Promise<boolean>;
  encryptionKey: string;
  replayPepper: string;
  now?: () => Date;
  verifyTotp?: typeof verifyEncryptedTotpCode;
}>;

function exactValue(value: unknown, maximum = 320): value is string {
  return (
    typeof value === "string" &&
    value !== "" &&
    value === value.trim() &&
    value.length <= maximum
  );
}

function canonicalOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username !== "" ||
      url.password !== "" ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== "" ||
      url.origin !== value
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

export function createTrustedPasskeyManagementContext(input: Readonly<{
  session: Readonly<{ userId: string; sessionId: string }>;
  requestOrigin: string | undefined;
  trustedOrigins: readonly string[];
}>): TrustedPasskeyManagementContext {
  if (
    !exactValue(input.session.userId) ||
    !exactValue(input.session.sessionId) ||
    input.requestOrigin === undefined
  ) {
    throw new Error("Passkey management context rejected.");
  }
  const origin = canonicalOrigin(input.requestOrigin);
  const accepted = new Set(
    input.trustedOrigins.map((value) => canonicalOrigin(value)),
  );
  if (origin === null || accepted.has(null) || !accepted.has(origin)) {
    throw new Error("Passkey management context rejected.");
  }
  return Object.freeze({
    userId: input.session.userId,
    sessionId: input.session.sessionId,
    [trustedContext]: true as const,
  });
}

export async function verifyPasskeyManagementFreshProof(
  context: TrustedPasskeyManagementContext,
  proof: Readonly<{ password: string; totpCode?: string }>,
  dependencies: PasskeyManagementProofDependencies,
): Promise<PasskeyManagementFreshProof | null> {
  if (
    context[trustedContext] !== true ||
    !exactValue(context.userId) ||
    !exactValue(context.sessionId) ||
    typeof proof.password !== "string" ||
    proof.password.length < AUTH_PASSWORD_MIN_LENGTH ||
    proof.password.length > AUTH_PASSWORD_MAX_LENGTH
  ) {
    return null;
  }

  const acceptedAt = (dependencies.now ?? (() => new Date()))();
  if (!Number.isFinite(acceptedAt.getTime())) return null;

  let state: PasskeyManagementSecurityState;
  try {
    state = await dependencies.loadSecurityState({
      userId: context.userId,
      sessionId: context.sessionId,
      observedAt: acceptedAt,
    });
  } catch {
    throw new Error("Passkey management proof unavailable.");
  }
  if (
    !state.sessionValid ||
    !exactValue(state.passwordHash, 4096) ||
    state.totp.state === "inconsistent"
  ) {
    return null;
  }

  let passwordVerified: boolean;
  try {
    passwordVerified = await dependencies.verifyPassword({
      hash: state.passwordHash,
      password: proof.password,
    });
  } catch {
    throw new Error("Passkey management proof unavailable.");
  }
  if (!passwordVerified) return null;

  if (state.totp.state === "absent") {
    if (proof.totpCode !== undefined) return null;
    return Object.freeze({
      userId: context.userId,
      sessionId: context.sessionId,
      acceptedAt,
      methods: Object.freeze(["password"] as const),
    });
  }

  if (
    !exactValue(state.totp.encryptedSecret, 4096) ||
    (state.totp.lockedUntil !== null &&
      (!Number.isFinite(state.totp.lockedUntil.getTime()) ||
        state.totp.lockedUntil.getTime() > acceptedAt.getTime())) ||
    typeof proof.totpCode !== "string" ||
    !isValidTotpCode(proof.totpCode)
  ) {
    return null;
  }

  let totpVerified: boolean;
  try {
    totpVerified = await (dependencies.verifyTotp ?? verifyEncryptedTotpCode)(
      dependencies.encryptionKey,
      state.totp.encryptedSecret,
      proof.totpCode,
    );
  } catch {
    throw new Error("Passkey management proof unavailable.");
  }
  if (!totpVerified) return null;

  const codeDigest = createTotpReplayDigest(
    dependencies.replayPepper,
    context.userId,
    proof.totpCode,
  );
  const expiresAt = new Date(acceptedAt.getTime() + TOTP_REPLAY_HORIZON_MS);
  let replayClaimed: boolean;
  try {
    replayClaimed = await dependencies.claimTotpReplay({
      userId: context.userId,
      codeDigest,
      acceptedAt,
      expiresAt,
    });
  } catch {
    throw new Error("Passkey management proof unavailable.");
  }
  const completedAt = (dependencies.now ?? (() => new Date()))();
  if (
    !replayClaimed ||
    !Number.isFinite(completedAt.getTime()) ||
    completedAt.getTime() < acceptedAt.getTime() ||
    completedAt.getTime() - acceptedAt.getTime() > FRESH_PROOF_MAX_AGE_MS
  ) {
    return null;
  }

  return Object.freeze({
    userId: context.userId,
    sessionId: context.sessionId,
    acceptedAt,
    methods: Object.freeze(["password", "totp"] as const),
  });
}
