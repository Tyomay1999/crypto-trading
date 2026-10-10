import {
  createHmac,
} from "node:crypto";

const TOTP_PATTERN =
  /^[0-9]{6}$/;

const REPLAY_DOMAIN =
  "delta:a4:totp-replay:v1";

export function createTotpReplayDigest(
  replayPepper: string,
  userId: string,
  code: string,
): string {
  if (replayPepper.length < 32) {
    throw new Error(
      "TOTP replay pepper is invalid.",
    );
  }

  if (
    userId.length === 0 ||
    userId !== userId.trim()
  ) {
    throw new Error(
      "TOTP replay user identity is invalid.",
    );
  }

  if (!TOTP_PATTERN.test(code)) {
    throw new Error(
      "TOTP replay code is invalid.",
    );
  }

  /*
   * TOTP_REPLAY_PEPPER is an independent secret,
   * not BETTER_AUTH_SECRET.
   *
   * The six-digit credential is never stored.
   */
  return createHmac(
    "sha256",
    replayPepper,
  )
    .update(
      REPLAY_DOMAIN,
      "utf8",
    )
    .update("\0", "utf8")
    .update(userId, "utf8")
    .update("\0", "utf8")
    .update(code, "utf8")
    .digest("hex");
}
