import { requireRecoveryPepper } from "./recovery-codes.js";

export const DELTA_WEBAUTHN_USER_VERIFICATION = "required" as const;
export const DELTA_WEBAUTHN_ATTESTATION = "none" as const;
export const DELTA_WEBAUTHN_RESIDENT_KEY = "preferred" as const;
export const DELTA_WEBAUTHN_REQUIRE_RESIDENT_KEY = false as const;
export const DELTA_WEBAUTHN_REQUIRE_USER_PRESENCE = true as const;

const WEBAUTHN_RP_NAME_MAX_CODE_POINTS = 64;
const RP_ID_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export type WebAuthnEnvironment = Readonly<{
  rpId: string;
  rpName: string;
  origin: string;
  userVerification: typeof DELTA_WEBAUTHN_USER_VERIFICATION;
  attestation: typeof DELTA_WEBAUTHN_ATTESTATION;
  residentKey: typeof DELTA_WEBAUTHN_RESIDENT_KEY;
  requireResidentKey: typeof DELTA_WEBAUTHN_REQUIRE_RESIDENT_KEY;
  requireUserPresence: typeof DELTA_WEBAUTHN_REQUIRE_USER_PRESENCE;
}>;

export type AuthEnvironment = Readonly<{
  secret: string;
  replayPepper: string;
  recoveryPepper: string;
  baseUrl: string;
  trustedOrigins: readonly string[];
  useSecureCookies: boolean;
  webauthn: WebAuthnEnvironment;
}>;

function requireSecret(
  value: string | undefined,
): string {
  if (
    value === undefined ||
    value.length < 32
  ) {
    throw new Error(
      "BETTER_AUTH_SECRET must contain at least 32 characters.",
    );
  }

  return value;
}

function requireReplayPepper(
  value: string | undefined,
  authSecret: string,
): string {
  if (
    value === undefined ||
    value.length < 32
  ) {
    throw new Error(
      "TOTP_REPLAY_PEPPER must contain at least 32 characters.",
    );
  }

  if (value === authSecret) {
    throw new Error(
      "TOTP_REPLAY_PEPPER must be independent from BETTER_AUTH_SECRET.",
    );
  }

  return value;
}

function parseBaseUrl(
  value: string | undefined,
): URL {
  if (
    value === undefined ||
    value.trim() === ""
  ) {
    throw new Error(
      "BETTER_AUTH_BASE_URL is required.",
    );
  }

  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new Error(
      "BETTER_AUTH_BASE_URL must be a valid URL.",
    );
  }

  if (
    url.protocol !== "http:" &&
    url.protocol !== "https:"
  ) {
    throw new Error(
      "BETTER_AUTH_BASE_URL must use http or https.",
    );
  }

  if (
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new Error(
      "BETTER_AUTH_BASE_URL must not contain credentials.",
    );
  }

  return url;
}

function parseTrustedOrigins(
  value: string | undefined,
  baseOrigin: string,
): readonly string[] {
  const origins = new Set<string>();

  origins.add(baseOrigin);

  if (
    value !== undefined &&
    value.trim() !== ""
  ) {
    for (const rawValue of value.split(",")) {
      const candidate = rawValue.trim();

      if (candidate === "") {
        continue;
      }

      let url: URL;

      try {
        url = new URL(candidate);
      } catch {
        throw new Error(
          `Invalid BETTER_AUTH_TRUSTED_ORIGINS entry: ${candidate}`,
        );
      }

      if (
        url.protocol !== "http:" &&
        url.protocol !== "https:"
      ) {
        throw new Error(
          `Trusted origin must use http or https: ${candidate}`,
        );
      }

      origins.add(url.origin);
    }
  }

  return Object.freeze(
    Array.from(origins),
  );
}

function isProductionEnvironment(
  value: string | undefined,
): boolean {
  const nodeEnvironment = value ?? "development";

  if (
    nodeEnvironment !== "development" &&
    nodeEnvironment !== "test" &&
    nodeEnvironment !== "production"
  ) {
    throw new Error(`Invalid NODE_ENV value: ${nodeEnvironment}`);
  }

  return nodeEnvironment === "production";
}

function requireWebAuthnRpId(
  value: string | undefined,
  production: boolean,
): string {
  if (
    value === undefined ||
    value === "" ||
    value !== value.trim() ||
    value.includes("*") ||
    !RP_ID_PATTERN.test(value) ||
    /^[0-9.]+$/.test(value)
  ) {
    throw new Error(
      "WEBAUTHN_RP_ID must be an explicit normalized hostname.",
    );
  }

  if (production && value === "localhost") {
    throw new Error(
      "WEBAUTHN_RP_ID must not be localhost in production.",
    );
  }

  return value;
}

function requireWebAuthnRpName(
  value: string | undefined,
): string {
  if (
    value === undefined ||
    value === "" ||
    value !== value.trim() ||
    Array.from(value).length > WEBAUTHN_RP_NAME_MAX_CODE_POINTS ||
    /[\u0000-\u001f\u007f-\u009f]/.test(value)
  ) {
    throw new Error(
      `WEBAUTHN_RP_NAME must contain 1-${WEBAUTHN_RP_NAME_MAX_CODE_POINTS} display characters without surrounding whitespace or controls.`,
    );
  }

  return value;
}

function requireWebAuthnOrigin(
  value: string | undefined,
  production: boolean,
): URL {
  if (
    value === undefined ||
    value === "" ||
    value !== value.trim() ||
    value.includes("*")
  ) {
    throw new Error("WEBAUTHN_ORIGIN must be one exact canonical origin.");
  }

  let origin: URL;
  try {
    origin = new URL(value);
  } catch {
    throw new Error("WEBAUTHN_ORIGIN must be one exact canonical origin.");
  }

  if (
    (origin.protocol !== "http:" && origin.protocol !== "https:") ||
    origin.username !== "" ||
    origin.password !== "" ||
    origin.pathname !== "/" ||
    origin.search !== "" ||
    origin.hash !== "" ||
    origin.origin !== value
  ) {
    throw new Error("WEBAUTHN_ORIGIN must be one exact canonical origin.");
  }

  if (origin.protocol === "http:" && origin.hostname !== "localhost") {
    throw new Error(
      "WEBAUTHN_ORIGIN may use HTTP only for localhost development.",
    );
  }

  if (
    production &&
    (origin.protocol !== "https:" || origin.hostname === "localhost")
  ) {
    throw new Error(
      "WEBAUTHN_ORIGIN must use HTTPS and a non-localhost host in production.",
    );
  }

  return origin;
}

export function parseWebAuthnConfig(
  source: NodeJS.ProcessEnv,
  trustedOrigins: readonly string[],
): WebAuthnEnvironment {
  const production = isProductionEnvironment(source.NODE_ENV);
  const rpId = requireWebAuthnRpId(source.WEBAUTHN_RP_ID, production);
  const rpName = requireWebAuthnRpName(source.WEBAUTHN_RP_NAME);
  const origin = requireWebAuthnOrigin(source.WEBAUTHN_ORIGIN, production);

  const originMatchesRpId =
    origin.hostname === rpId || origin.hostname.endsWith(`.${rpId}`);
  if (
    !originMatchesRpId ||
    (rpId === "localhost" && origin.hostname !== "localhost")
  ) {
    throw new Error(
      "WEBAUTHN_ORIGIN hostname must equal or be a subdomain of WEBAUTHN_RP_ID.",
    );
  }

  if (!trustedOrigins.includes(origin.origin)) {
    throw new Error(
      "WEBAUTHN_ORIGIN must be present in BETTER_AUTH_TRUSTED_ORIGINS.",
    );
  }

  return Object.freeze({
    rpId,
    rpName,
    origin: origin.origin,
    userVerification: DELTA_WEBAUTHN_USER_VERIFICATION,
    attestation: DELTA_WEBAUTHN_ATTESTATION,
    residentKey: DELTA_WEBAUTHN_RESIDENT_KEY,
    requireResidentKey: DELTA_WEBAUTHN_REQUIRE_RESIDENT_KEY,
    requireUserPresence: DELTA_WEBAUTHN_REQUIRE_USER_PRESENCE,
  });
}

export function loadAuthEnv(
  source: NodeJS.ProcessEnv = process.env,
): AuthEnvironment {
  const secret = requireSecret(
    source.BETTER_AUTH_SECRET,
  );

  const replayPepper =
    requireReplayPepper(
      source.TOTP_REPLAY_PEPPER,
      secret,
    );

  const recoveryPepper = requireRecoveryPepper(
    source.RECOVERY_CODE_PEPPER,
    secret,
    replayPepper,
  );

  const baseUrl = parseBaseUrl(
    source.BETTER_AUTH_BASE_URL,
  );

  const trustedOrigins =
    parseTrustedOrigins(
      source.BETTER_AUTH_TRUSTED_ORIGINS,
      baseUrl.origin,
    );

  const webauthn = parseWebAuthnConfig(
    source,
    trustedOrigins,
  );

  return Object.freeze({
    secret,
    replayPepper,
    recoveryPepper,
    baseUrl: baseUrl.origin,
    trustedOrigins,
    useSecureCookies:
      baseUrl.protocol === "https:",
    webauthn,
  });
}
