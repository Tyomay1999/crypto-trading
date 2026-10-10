import { randomBytes } from "node:crypto";
import type {
  GenericEndpointContext,
  InternalAdapter,
} from "@better-auth/core";

export const PASSKEY_CHALLENGE_TTL_SECONDS = 300;
export const PASSKEY_LOOKUP_RANDOM_BYTES = 32;
export const PASSKEY_LOOKUP_RANDOM_ENTROPY_BITS =
  PASSKEY_LOOKUP_RANDOM_BYTES * 8;

const PASSKEY_LOOKUP_COOKIE_SUFFIX = "delta_passkey_challenge";
const PASSKEY_LOOKUP_COOKIE_PATH = "/api";
const PASSKEY_CHALLENGE_VERSION = 1 as const;
const LOOKUP_PATTERN =
  /^delta:webauthn:(registration|authentication):[A-Za-z0-9_-]{43}$/;
const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{16,1024}$/;

export type PasskeyCeremonyKind = "registration" | "authentication";

export type PasskeyChallengeInput =
  | Readonly<{
      ceremony: "registration";
      challenge: string;
      userId: string;
    }>
  | Readonly<{
      ceremony: "authentication";
      challenge: string;
      userId?: string | null;
    }>;

export type PasskeyChallengeExpectation =
  | Readonly<{
      ceremony: "registration";
      userId: string;
    }>
  | Readonly<{
      ceremony: "authentication";
      userId?: string | null;
    }>;

export type PasskeyChallengePayload = Readonly<{
  version: typeof PASSKEY_CHALLENGE_VERSION;
  ceremony: PasskeyCeremonyKind;
  challenge: string;
  userId: string | null;
}>;

type PasskeyChallengeInternalAdapter = Pick<
  InternalAdapter,
  "consumeVerificationValue" | "createVerificationValue"
>;

export type PasskeyChallengeContext = Pick<
  GenericEndpointContext,
  "getSignedCookie" | "setCookie" | "setSignedCookie"
> & {
  context: Pick<
    GenericEndpointContext["context"],
    "createAuthCookie" | "secret"
  > & {
    internalAdapter: PasskeyChallengeInternalAdapter;
  };
};

function validOpaqueValue(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value !== "" &&
    value === value.trim() &&
    value.length <= maximum
  );
}

function validChallenge(value: unknown): value is string {
  return typeof value === "string" && CHALLENGE_PATTERN.test(value);
}

function passkeyLookupCookie(ctx: PasskeyChallengeContext) {
  return ctx.context.createAuthCookie(PASSKEY_LOOKUP_COOKIE_SUFFIX, {
    httpOnly: true,
    sameSite: "lax",
    path: PASSKEY_LOOKUP_COOKIE_PATH,
    maxAge: PASSKEY_CHALLENGE_TTL_SECONDS,
  });
}

function createLookupIdentifier(ceremony: PasskeyCeremonyKind): string {
  const opaque = randomBytes(PASSKEY_LOOKUP_RANDOM_BYTES).toString("base64url");
  return `delta:webauthn:${ceremony}:${opaque}`;
}

function parsePayload(value: string): PasskeyChallengePayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const candidate = parsed as Record<string, unknown>;
  if (
    Object.keys(candidate).sort().join(",") !==
      "ceremony,challenge,userId,version" ||
    candidate.version !== PASSKEY_CHALLENGE_VERSION ||
    (candidate.ceremony !== "registration" &&
      candidate.ceremony !== "authentication") ||
    !validChallenge(candidate.challenge) ||
    (candidate.userId !== null && !validOpaqueValue(candidate.userId, 256)) ||
    (candidate.ceremony === "registration" && candidate.userId === null)
  ) {
    return null;
  }

  return Object.freeze({
    version: PASSKEY_CHALLENGE_VERSION,
    ceremony: candidate.ceremony,
    challenge: candidate.challenge,
    userId: candidate.userId,
  });
}

export async function createPasskeyChallenge(
  ctx: PasskeyChallengeContext,
  input: PasskeyChallengeInput,
): Promise<Readonly<{ identifier: string; expiresAt: Date }>> {
  if (
    !validChallenge(input.challenge) ||
    (input.ceremony === "registration" &&
      !validOpaqueValue(input.userId, 256)) ||
    (input.ceremony === "authentication" &&
      input.userId !== undefined &&
      input.userId !== null &&
      !validOpaqueValue(input.userId, 256))
  ) {
    throw new Error("Invalid passkey challenge input.");
  }

  const identifier = createLookupIdentifier(input.ceremony);
  const expiresAt = new Date(
    Date.now() + PASSKEY_CHALLENGE_TTL_SECONDS * 1_000,
  );
  const payload: PasskeyChallengePayload = {
    version: PASSKEY_CHALLENGE_VERSION,
    ceremony: input.ceremony,
    challenge: input.challenge,
    userId: input.userId ?? null,
  };

  const created = await ctx.context.internalAdapter.createVerificationValue({
    identifier,
    value: JSON.stringify(payload),
    expiresAt,
  });
  if (!created) throw new Error("Passkey challenge storage unavailable.");

  const cookie = passkeyLookupCookie(ctx);
  await ctx.setSignedCookie(
    cookie.name,
    identifier,
    ctx.context.secret,
    cookie.attributes,
  );

  return Object.freeze({ identifier, expiresAt });
}

export async function claimPasskeyChallenge(
  ctx: PasskeyChallengeContext,
  expected: PasskeyChallengeExpectation,
): Promise<PasskeyChallengePayload | null> {
  if (
    expected.ceremony === "registration" &&
    !validOpaqueValue(expected.userId, 256)
  ) {
    return null;
  }
  if (
    expected.ceremony === "authentication" &&
    expected.userId !== undefined &&
    expected.userId !== null &&
    !validOpaqueValue(expected.userId, 256)
  ) {
    return null;
  }

  const cookie = passkeyLookupCookie(ctx);
  const identifier = await ctx.getSignedCookie(
    cookie.name,
    ctx.context.secret,
  );
  if (
    typeof identifier !== "string" ||
    !LOOKUP_PATTERN.test(identifier) ||
    !identifier.startsWith(`delta:webauthn:${expected.ceremony}:`)
  ) {
    return null;
  }

  // Better Auth resolves this primitive against the current adapter. When an
  // outer runWithTransaction is active, the claim joins that transaction; it
  // deliberately creates no independent pg PoolClient transaction here.
  const consumed =
    await ctx.context.internalAdapter.consumeVerificationValue(identifier);
  if (!consumed) return null;

  const expiresAt = new Date(consumed.expiresAt).getTime();
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;

  const payload = parsePayload(consumed.value);
  if (!payload || payload.ceremony !== expected.ceremony) return null;

  if (
    expected.ceremony === "registration" &&
    payload.userId !== expected.userId
  ) {
    return null;
  }
  if (
    expected.ceremony === "authentication" &&
    expected.userId !== undefined &&
    payload.userId !== expected.userId
  ) {
    return null;
  }

  return payload;
}

export function clearPasskeyLookupCookie(
  ctx: PasskeyChallengeContext,
): void {
  const cookie = passkeyLookupCookie(ctx);
  ctx.setCookie(cookie.name, "", {
    ...cookie.attributes,
    maxAge: 0,
  });
}
