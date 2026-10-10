import { createHmac, randomBytes } from "node:crypto";

export const RECOVERY_CODE_COUNT = 10;
// 32 equally likely ASCII symbols, excluding 0, 1, I and O.
const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const GROUP = `[${ALPHABET}]{4}`;
const FORMAT = new RegExp(`^${GROUP}(?:-${GROUP}){7}$`);

export function requireRecoveryPepper(
  value: string | undefined,
  authSecret: string,
  replayPepper: string,
): string {
  if (value === undefined || Buffer.byteLength(value, "utf8") < 32) {
    throw new Error(
      "RECOVERY_CODE_PEPPER must contain at least 32 UTF-8 bytes.",
    );
  }
  const bytes = Buffer.from(value, "utf8");
  if (
    bytes.equals(Buffer.from(authSecret, "utf8")) ||
    bytes.equals(Buffer.from(replayPepper, "utf8"))
  ) {
    throw new Error(
      "RECOVERY_CODE_PEPPER must be independent from auth and TOTP secrets.",
    );
  }
  return value;
}

export function normalizeRecoveryCode(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.length !== 39 ||
    !/^[\x20-\x7e]+$/.test(value)
  )
    return null;
  return FORMAT.test(value) ? value : null;
}

export function generateRecoveryCodes(): string[] {
  const result = new Set<string>();
  while (result.size < RECOVERY_CODE_COUNT) {
    // 32 independent five-bit symbols: 160 bits per code, with no modulo bias.
    const raw = Array.from(randomBytes(32), (byte) => ALPHABET[byte & 31]).join(
      "",
    );
    result.add(raw.match(/.{4}/g)!.join("-"));
  }
  return [...result];
}

/** Internal INSERT/WHERE codec. PostgreSQL decodes this parameter into BYTEA. */
export function recoveryDigest(
  pepper: string,
  userId: string,
  generation: string,
  code: string,
): string {
  const canonical = normalizeRecoveryCode(code);
  if (
    Buffer.byteLength(pepper, "utf8") < 32 ||
    !userId ||
    !generation ||
    canonical === null
  ) {
    throw new Error("Invalid recovery digest input.");
  }
  const hex = createHmac("sha256", Buffer.from(pepper, "utf8"))
    .update(
      JSON.stringify(["delta:recovery-code:v1", userId, generation, canonical]),
      "utf8",
    )
    .digest("hex");
  return `\\x${hex}`;
}
