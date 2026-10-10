import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type CredentialDeviceType,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
  type Uint8Array_,
} from "@simplewebauthn/server";
import type { DBTransactionAdapter } from "better-auth";

import type { WebAuthnEnvironment } from "./config.js";
import {
  claimPasskeyChallenge,
  createPasskeyChallenge,
  type PasskeyChallengeContext,
} from "./passkey-challenge.js";
import {
  passkeyCounterFromDatabase,
  passkeyCounterToDatabase,
} from "./passkey-counter.js";

const CREDENTIAL_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const STANDARD_BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const USER_VALUE_MAX = 320;
const PASSKEY_NAME_MAX = 64;
const AAGUID_MAX = 64;
const TRANSPORTS = new Set<AuthenticatorTransportFuture>([
  "ble",
  "cable",
  "hybrid",
  "internal",
  "nfc",
  "smart-card",
  "usb",
]);

type GenerateRegistration = typeof generateRegistrationOptions;
type VerifyRegistration = typeof verifyRegistrationResponse;
type GenerateAuthentication = typeof generateAuthenticationOptions;
type VerifyAuthentication = typeof verifyAuthenticationResponse;

export type PasskeyCeremonyErrorCode =
  | "AUTHENTICATION_REJECTED"
  | "CHALLENGE_REJECTED"
  | "CREDENTIAL_CONFLICT"
  | "CREDENTIAL_REJECTED"
  | "REGISTRATION_REJECTED"
  | "SERVICE_UNAVAILABLE";

export class PasskeyCeremonyError extends Error {
  readonly code: PasskeyCeremonyErrorCode;

  constructor(code: PasskeyCeremonyErrorCode) {
    super("Passkey ceremony rejected.");
    this.name = "PasskeyCeremonyError";
    this.code = code;
  }
}

export type PasskeyCredentialRecord = Readonly<{
  id: string;
  name: string | null;
  publicKey: string;
  userId: string;
  credentialID: string;
  counter: unknown;
  deviceType: CredentialDeviceType;
  backedUp: boolean;
  transports: string | null;
  createdAt: Date | null;
  aaguid: string | null;
}>;

export type VerifiedPasskeyRegistration = Readonly<{
  passkeyId: string;
  userId: string;
  credentialID: string;
  userVerified: true;
  credentialDeviceType: CredentialDeviceType;
  credentialBackedUp: boolean;
  aaguid: string | null;
  transports: string | null;
}>;

export type VerifiedPasskeyAuthentication = Readonly<{
  passkeyId: string;
  userId: string;
  newCounter: number;
  userVerified: true;
  credentialDeviceType: CredentialDeviceType;
  credentialBackedUp: boolean;
  aaguid: string | null;
  transports: string | null;
}>;

type PasskeyCeremonyDependencies = Readonly<{
  generateRegistrationOptions: GenerateRegistration;
  verifyRegistrationResponse: VerifyRegistration;
  generateAuthenticationOptions: GenerateAuthentication;
  verifyAuthenticationResponse: VerifyAuthentication;
  createChallenge: typeof createPasskeyChallenge;
  claimChallenge: typeof claimPasskeyChallenge;
  now: () => Date;
}>;

const productionDependencies: PasskeyCeremonyDependencies = {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  createChallenge: createPasskeyChallenge,
  claimChallenge: claimPasskeyChallenge,
  now: () => new Date(),
};

function reject(code: PasskeyCeremonyErrorCode): never {
  throw new PasskeyCeremonyError(code);
}

function exactBounded(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value !== "" &&
    value === value.trim() &&
    value.length <= maximum
  );
}

export function canonicalCredentialId(value: unknown): string {
  if (
    !exactBounded(value, 2048) ||
    !CREDENTIAL_ID_PATTERN.test(value) ||
    Buffer.from(value, "base64url").toString("base64url") !== value
  ) {
    return reject("CREDENTIAL_REJECTED");
  }
  return value;
}

export function encodePasskeyPublicKey(value: Uint8Array): string {
  if (!(value instanceof Uint8Array) || value.byteLength === 0) {
    return reject("CREDENTIAL_REJECTED");
  }
  return Buffer.from(value).toString("base64");
}

export function decodePasskeyPublicKey(value: unknown): Uint8Array_ {
  if (
    !exactBounded(value, 16_384) ||
    value.length % 4 !== 0 ||
    !STANDARD_BASE64_PATTERN.test(value)
  ) {
    return reject("CREDENTIAL_REJECTED");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.byteLength === 0 || decoded.toString("base64") !== value) {
    return reject("CREDENTIAL_REJECTED");
  }
  return Uint8Array.from(decoded);
}

function parseTransports(
  value: string | null | undefined,
): AuthenticatorTransportFuture[] | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const parsed = value.split(",");
  if (
    parsed.length > TRANSPORTS.size ||
    new Set(parsed).size !== parsed.length ||
    parsed.some((transport) => !TRANSPORTS.has(transport as AuthenticatorTransportFuture))
  ) {
    return reject("CREDENTIAL_REJECTED");
  }
  return parsed as AuthenticatorTransportFuture[];
}

function serializeTransports(
  value: readonly AuthenticatorTransportFuture[] | undefined,
): string | null {
  if (value === undefined || value.length === 0) return null;
  if (
    value.length > TRANSPORTS.size ||
    new Set(value).size !== value.length ||
    value.some((transport) => !TRANSPORTS.has(transport))
  ) {
    return reject("CREDENTIAL_REJECTED");
  }
  return value.join(",");
}

function validateStoredCounter(value: unknown): number {
  try {
    if (typeof value === "string") return passkeyCounterFromDatabase(value);
    if (typeof value === "number") {
      return passkeyCounterFromDatabase(passkeyCounterToDatabase(value));
    }
  } catch {
    return reject("CREDENTIAL_REJECTED");
  }
  return reject("CREDENTIAL_REJECTED");
}

function validateCounter(value: unknown): number {
  try {
    passkeyCounterToDatabase(value);
  } catch {
    return reject("CREDENTIAL_REJECTED");
  }
  return value as number;
}

function validDeviceType(value: unknown): value is CredentialDeviceType {
  return value === "singleDevice" || value === "multiDevice";
}

function normalizeName(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  if (!exactBounded(value, PASSKEY_NAME_MAX) || /[\u0000-\u001f\u007f-\u009f]/.test(value)) {
    return reject("REGISTRATION_REJECTED");
  }
  return value;
}

function normalizeAaguid(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (!exactBounded(value, AAGUID_MAX)) return reject("CREDENTIAL_REJECTED");
  return value;
}

function isDuplicateCredentialError(error: unknown): boolean {
  let candidate: unknown = error;
  for (let depth = 0; depth < 3; depth += 1) {
    if (typeof candidate !== "object" || candidate === null) return false;
    const record = candidate as Record<string, unknown>;
    if (
      record.code === "23505" &&
      record.constraint === "passkey_credentialID_key"
    ) {
      return true;
    }
    candidate = record.cause;
  }
  return false;
}

function passkeyDescriptors(records: readonly PasskeyCredentialRecord[]) {
  return records.map((record) => ({
    id: canonicalCredentialId(record.credentialID),
    transports: parseTransports(record.transports),
  }));
}

export function createPasskeyCeremonyServices(
  overrides: Partial<PasskeyCeremonyDependencies> = {},
) {
  const dependencies: PasskeyCeremonyDependencies = {
    ...productionDependencies,
    ...overrides,
  };

  async function registrationOptions(input: Readonly<{
    adapter: DBTransactionAdapter;
    challengeContext: PasskeyChallengeContext;
    config: WebAuthnEnvironment;
    user: Readonly<{ id: string; email: string; displayName?: string | null }>;
  }>): Promise<PublicKeyCredentialCreationOptionsJSON> {
    if (
      !exactBounded(input.user.id, USER_VALUE_MAX) ||
      !exactBounded(input.user.email, USER_VALUE_MAX) ||
      (input.user.displayName !== undefined &&
        input.user.displayName !== null &&
        !exactBounded(input.user.displayName, USER_VALUE_MAX))
    ) {
      return reject("REGISTRATION_REJECTED");
    }

    let existing: PasskeyCredentialRecord[];
    try {
      existing = await input.adapter.findMany<PasskeyCredentialRecord>({
        model: "passkey",
        where: [{ field: "userId", value: input.user.id }],
      });
    } catch {
      return reject("SERVICE_UNAVAILABLE");
    }

    let options: PublicKeyCredentialCreationOptionsJSON;
    try {
      options = await dependencies.generateRegistrationOptions({
        rpName: input.config.rpName,
        rpID: input.config.rpId,
        userName: input.user.email,
        userDisplayName: input.user.displayName ?? input.user.email,
        attestationType: input.config.attestation,
        excludeCredentials: passkeyDescriptors(existing),
        authenticatorSelection: {
          userVerification: input.config.userVerification,
          residentKey: input.config.residentKey,
          requireResidentKey: input.config.requireResidentKey,
        },
      });
      await dependencies.createChallenge(input.challengeContext, {
        ceremony: "registration",
        challenge: options.challenge,
        userId: input.user.id,
      });
    } catch (error) {
      if (error instanceof PasskeyCeremonyError) throw error;
      return reject("SERVICE_UNAVAILABLE");
    }
    return options;
  }

  async function verifyRegistration(input: Readonly<{
    adapter: DBTransactionAdapter;
    challengeContext: PasskeyChallengeContext;
    config: WebAuthnEnvironment;
    userId: string;
    response: RegistrationResponseJSON;
    name?: string | null;
  }>): Promise<VerifiedPasskeyRegistration> {
    if (!exactBounded(input.userId, USER_VALUE_MAX)) {
      return reject("REGISTRATION_REJECTED");
    }
    let claimed: Awaited<ReturnType<typeof claimPasskeyChallenge>>;
    try {
      claimed = await dependencies.claimChallenge(input.challengeContext, {
        ceremony: "registration",
        userId: input.userId,
      });
    } catch {
      return reject("SERVICE_UNAVAILABLE");
    }
    if (!claimed) return reject("CHALLENGE_REJECTED");

    let verification: Awaited<ReturnType<VerifyRegistration>>;
    try {
      verification = await dependencies.verifyRegistrationResponse({
        response: input.response,
        expectedChallenge: claimed.challenge,
        expectedOrigin: input.config.origin,
        expectedRPID: input.config.rpId,
        requireUserPresence: input.config.requireUserPresence,
        requireUserVerification: true,
      });
    } catch {
      return reject("REGISTRATION_REJECTED");
    }
    if (
      !verification.verified ||
      !verification.registrationInfo ||
      verification.registrationInfo.userVerified !== true ||
      (verification.registrationInfo.credentialBackedUp !== true &&
        verification.registrationInfo.credentialBackedUp !== false)
    ) {
      return reject("REGISTRATION_REJECTED");
    }

    const info = verification.registrationInfo;
    const credentialID = canonicalCredentialId(info.credential.id);
    if (canonicalCredentialId(input.response.id) !== credentialID) {
      return reject("CREDENTIAL_REJECTED");
    }
    const publicKey = encodePasskeyPublicKey(info.credential.publicKey);
    const counter = validateCounter(info.credential.counter);
    if (!validDeviceType(info.credentialDeviceType)) {
      return reject("CREDENTIAL_REJECTED");
    }
    const transports = serializeTransports(info.credential.transports);
    const aaguid = normalizeAaguid(info.aaguid);
    const createdAt = dependencies.now();
    if (!Number.isFinite(createdAt.getTime())) return reject("SERVICE_UNAVAILABLE");

    let created: PasskeyCredentialRecord;
    try {
      created = await input.adapter.create<
        Omit<PasskeyCredentialRecord, "id">,
        PasskeyCredentialRecord
      >({
        model: "passkey",
        data: {
          name: normalizeName(input.name),
          publicKey,
          userId: input.userId,
          credentialID,
          counter,
          deviceType: info.credentialDeviceType,
          backedUp: info.credentialBackedUp,
          transports,
          createdAt,
          aaguid,
        },
      });
    } catch (error) {
      if (isDuplicateCredentialError(error)) return reject("CREDENTIAL_CONFLICT");
      return reject("SERVICE_UNAVAILABLE");
    }
    if (!created || !exactBounded(created.id, 256)) {
      return reject("SERVICE_UNAVAILABLE");
    }

    return Object.freeze({
      passkeyId: created.id,
      userId: input.userId,
      credentialID,
      userVerified: true,
      credentialDeviceType: info.credentialDeviceType,
      credentialBackedUp: info.credentialBackedUp,
      aaguid,
      transports,
    });
  }

  async function authenticationOptions(input: Readonly<{
    adapter: DBTransactionAdapter;
    challengeContext: PasskeyChallengeContext;
    config: WebAuthnEnvironment;
    authoritativeUserId?: string;
  }>): Promise<PublicKeyCredentialRequestOptionsJSON> {
    let allowCredentials: ReturnType<typeof passkeyDescriptors> | undefined;
    if (input.authoritativeUserId !== undefined) {
      if (!exactBounded(input.authoritativeUserId, USER_VALUE_MAX)) {
        return reject("AUTHENTICATION_REJECTED");
      }
      try {
        const existing = await input.adapter.findMany<PasskeyCredentialRecord>({
          model: "passkey",
          where: [{ field: "userId", value: input.authoritativeUserId }],
        });
        allowCredentials = passkeyDescriptors(existing);
      } catch {
        return reject("SERVICE_UNAVAILABLE");
      }
    }

    let options: PublicKeyCredentialRequestOptionsJSON;
    try {
      options = await dependencies.generateAuthenticationOptions({
        rpID: input.config.rpId,
        userVerification: input.config.userVerification,
        ...(allowCredentials === undefined ? {} : { allowCredentials }),
      });
      await dependencies.createChallenge(input.challengeContext, {
        ceremony: "authentication",
        challenge: options.challenge,
      });
    } catch (error) {
      if (error instanceof PasskeyCeremonyError) throw error;
      return reject("SERVICE_UNAVAILABLE");
    }
    return options;
  }

  async function verifyAuthentication(input: Readonly<{
    adapter: DBTransactionAdapter;
    challengeContext: PasskeyChallengeContext;
    config: WebAuthnEnvironment;
    response: AuthenticationResponseJSON;
  }>): Promise<VerifiedPasskeyAuthentication> {
    let claimed: Awaited<ReturnType<typeof claimPasskeyChallenge>>;
    try {
      claimed = await dependencies.claimChallenge(input.challengeContext, {
        ceremony: "authentication",
      });
    } catch {
      return reject("SERVICE_UNAVAILABLE");
    }
    if (!claimed) return reject("CHALLENGE_REJECTED");

    const credentialID = canonicalCredentialId(input.response.id);
    let passkey: PasskeyCredentialRecord | null;
    try {
      passkey = await input.adapter.findOne<PasskeyCredentialRecord>({
        model: "passkey",
        where: [{ field: "credentialID", value: credentialID }],
      });
    } catch {
      return reject("SERVICE_UNAVAILABLE");
    }
    if (!passkey || passkey.credentialID !== credentialID) {
      return reject("AUTHENTICATION_REJECTED");
    }

    const publicKey = decodePasskeyPublicKey(passkey.publicKey);
    const counter = validateStoredCounter(passkey.counter);
    const transports = parseTransports(passkey.transports);

    let verification: Awaited<ReturnType<VerifyAuthentication>>;
    try {
      verification = await dependencies.verifyAuthenticationResponse({
        response: input.response,
        expectedChallenge: claimed.challenge,
        expectedOrigin: input.config.origin,
        expectedRPID: input.config.rpId,
        credential: {
          id: credentialID,
          publicKey,
          counter,
          transports,
        },
        requireUserVerification: true,
      });
    } catch {
      return reject("AUTHENTICATION_REJECTED");
    }
    if (
      !verification.verified ||
      verification.authenticationInfo.userVerified !== true ||
      verification.authenticationInfo.credentialID !== credentialID ||
      !validDeviceType(verification.authenticationInfo.credentialDeviceType) ||
      typeof verification.authenticationInfo.credentialBackedUp !== "boolean"
    ) {
      return reject("AUTHENTICATION_REJECTED");
    }
    const newCounter = validateCounter(
      verification.authenticationInfo.newCounter,
    );
    if (
      !exactBounded(passkey.id, 256) ||
      !exactBounded(passkey.userId, USER_VALUE_MAX)
    ) {
      return reject("CREDENTIAL_REJECTED");
    }
    const aaguid = normalizeAaguid(passkey.aaguid);

    return Object.freeze({
      passkeyId: passkey.id,
      userId: passkey.userId,
      newCounter,
      userVerified: true,
      credentialDeviceType: verification.authenticationInfo.credentialDeviceType,
      credentialBackedUp: verification.authenticationInfo.credentialBackedUp,
      aaguid,
      transports: passkey.transports,
    });
  }

  return Object.freeze({
    registrationOptions,
    verifyRegistration,
    authenticationOptions,
    verifyAuthentication,
  });
}

export const passkeyCeremonyServices = createPasskeyCeremonyServices();
