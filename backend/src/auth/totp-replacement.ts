import {
  generateRandomString,
  symmetricDecrypt,
  symmetricEncrypt,
} from "better-auth/crypto";
import {
  createOTP,
} from "@better-auth/utils/otp";

const TOTP_DIGITS = 6;
const TOTP_PERIOD_SECONDS = 30;

export const TOTP_REPLACEMENT_TTL_MS =
  10 * 60 * 1000;

const TOTP_CODE_PATTERN =
  /^[0-9]{6}$/;

export type TotpReplacementMaterial = {
  replacementId: string;
  encryptedSecret: string;
  totpUri: string;
};

export function isValidTotpCode(
  value: string,
): boolean {
  return TOTP_CODE_PATTERN.test(value);
}

export async function
createTotpReplacementMaterial(
  encryptionKey: string,
): Promise<TotpReplacementMaterial> {
  if (encryptionKey.length < 32) {
    throw new Error(
      "TOTP encryption key is invalid.",
    );
  }

  const secret =
    generateRandomString(32);

  const replacementId =
    generateRandomString(
      32,
      "a-z",
      "A-Z",
      "0-9",
    );

  const encryptedSecret =
    await symmetricEncrypt({
      key:
        encryptionKey,

      data:
        secret,
    });

  const totpUri =
    createOTP(
      secret,
      {
        digits:
          TOTP_DIGITS,

        period:
          TOTP_PERIOD_SECONDS,
      },
    ).url(
      "Delta",
      "Delta account",
    );

  return {
    replacementId,
    encryptedSecret,
    totpUri,
  };
}

export async function verifyEncryptedTotpCode(
  encryptionKey: string,
  encryptedSecret: string,
  code: string,
): Promise<boolean> {
  if (
    encryptionKey.length < 32 ||
    encryptedSecret.length === 0 ||
    !isValidTotpCode(code)
  ) {
    return false;
  }

  const secret =
    await symmetricDecrypt({
      key:
        encryptionKey,

      data:
        encryptedSecret,
    });

  return createOTP(
    secret,
    {
      digits:
        TOTP_DIGITS,

      period:
        TOTP_PERIOD_SECONDS,
    },
  ).verify(code);
}
