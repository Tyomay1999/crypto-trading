import {
  getCurrentAdapter,
  runWithTransaction,
} from "@better-auth/core/context";
import type {
  GenericEndpointContext,
} from "@better-auth/core";
import type {
  BetterAuthPlugin,
  DBAdapter,
  DBTransactionAdapter,
} from "better-auth";
import {
  createAuthEndpoint,
  getSessionFromCtx,
} from "better-auth/api";
import type { Pool } from "pg";

import type {
  AuthEnvironment,
  WebAuthnEnvironment,
} from "./config.js";
import type {
  PasskeyTestTransactionSelectorCapability,
} from "./passkey-test-transaction-selector.js";
import {
  PasskeyCeremonyError,
  passkeyCeremonyServices,
} from "./passkey-ceremony.js";
import {
  clearPasskeyLookupCookie,
  type PasskeyChallengeContext,
} from "./passkey-challenge.js";
import {
  createTrustedPasskeyManagementContext,
  verifyPasskeyManagementFreshProof,
  type PasskeyManagementProofDependencies,
} from "./passkey-management-proof.js";
import {
  tryLogPasskeySecurityAuditEvent,
  type MfaSecurityOutcome,
  type PasskeyAuditMetadata,
  type PasskeySecurityAction,
} from "./mfa-security-audit.js";
import {
  createPasskeyDurableRateLimiter,
  type PasskeyRateLimitOperation,
} from "../storage/passkey-rate-limit.js";

export const DELTA_INTERNAL_PASSKEY_ENROLLMENT_PATHS =
  Object.freeze([
    "/delta-passkey/enrollment/options",
    "/delta-passkey/enrollment/verify",
  ] as const);

export const DELTA_INTERNAL_PASSKEY_ENROLLMENT_API_METHODS =
  Object.freeze([
    "deltaPasskeyEnrollmentOptions",
    "deltaPasskeyEnrollmentVerify",
  ] as const);

export const DELTA_INTERNAL_PASSKEY_ENROLLMENT_ENDPOINT_COUNT =
  2 as const;

export const DELTA_INTERNAL_PASSKEY_AUTHENTICATION_PATHS =
  Object.freeze([
    "/delta-passkey/authentication/options",
    "/delta-passkey/authentication/verify",
  ] as const);

export const DELTA_INTERNAL_PASSKEY_AUTHENTICATION_API_METHODS =
  Object.freeze([
    "deltaPasskeyAuthenticationOptions",
    "deltaPasskeyAuthenticationVerify",
  ] as const);

export const DELTA_INTERNAL_PASSKEY_AUTHENTICATION_ENDPOINT_COUNT =
  2 as const;

const GENERIC_MESSAGE =
  "Passkey request could not be completed." as const;
const REQUEST_ID_PATTERN =
  /^[A-Za-z0-9._:-]{1,128}$/;
const IDENTITY_MAX_LENGTH = 256;
const PASSKEY_NAME_MAX_LENGTH = 64;
const CONTROL_CHARACTERS =
  /[\u0000-\u001f\u007f-\u009f]/;

export type PasskeyEnrollmentErrorCode =
  | "PASSKEY_REQUEST_REJECTED"
  | "PASSKEY_RATE_LIMITED"
  | "PASSKEY_FRESH_PROOF_REJECTED"
  | "PASSKEY_CREDENTIAL_CONFLICT"
  | "PASSKEY_UNAVAILABLE";

type RegistrationOptions = Awaited<
  ReturnType<
    typeof passkeyCeremonyServices.registrationOptions
  >
>;

type RegistrationResponse = Parameters<
  typeof passkeyCeremonyServices.verifyRegistration
>[0]["response"];

type AuthenticationOptions = Awaited<
  ReturnType<
    typeof passkeyCeremonyServices.authenticationOptions
  >
>;

type AuthenticatePasskey =
  typeof import("./passkey-plugin.js")["authenticatePasskey"];

type AuthenticationResponse = Parameters<
  AuthenticatePasskey
>[0]["response"];

export type PasskeyEnrollmentView = Readonly<{
  id: string;
  name: string | null;
  deviceType:
    | "singleDevice"
    | "multiDevice";
  backedUp: boolean;
}>;

export type PasskeyEnrollmentOptionsOutcome =
  | Readonly<{
      kind: "success";
      options: RegistrationOptions;
    }>
  | Readonly<{
      kind: "error";
      code: PasskeyEnrollmentErrorCode;
    }>;

export type PasskeyEnrollmentVerifyOutcome =
  | Readonly<{
      kind: "success";
      passkey: PasskeyEnrollmentView;
    }>
  | Readonly<{
      kind: "error";
      code: PasskeyEnrollmentErrorCode;
    }>;

export type PasskeyAuthenticationOptionsOutcome =
  | Readonly<{
      kind: "success";
      options: AuthenticationOptions;
    }>
  | Readonly<{
      kind: "error";
      code: PasskeyEnrollmentErrorCode;
    }>;

export type PasskeyAuthenticationVerifyOutcome =
  | Readonly<{
      kind: "success";
      status: true;
    }>
  | Readonly<{
      kind: "error";
      code: PasskeyEnrollmentErrorCode;
    }>;

type PasskeyEnrollmentIdentity = Readonly<{
  kind: "network" | "user";
  source: string;
}>;

type PasskeyEnrollmentAudit = (
  requestId: string,
  action: PasskeySecurityAction,
  outcome: MfaSecurityOutcome,
  metadata: PasskeyAuditMetadata,
) => void;

export type PasskeyEnrollmentDependencies = Readonly<{
  runTransaction: typeof runWithTransaction;
  currentAdapter: typeof getCurrentAdapter;
  takeDurableLimit: ReturnType<
    typeof createPasskeyDurableRateLimiter
  >;
  registrationOptions:
    typeof passkeyCeremonyServices.registrationOptions;
  verifyRegistration:
    typeof passkeyCeremonyServices.verifyRegistration;
  createTrustedContext:
    typeof createTrustedPasskeyManagementContext;
  verifyFreshProof:
    typeof verifyPasskeyManagementFreshProof;
  clearLookupCookie:
    typeof clearPasskeyLookupCookie;
  emitAudit: PasskeyEnrollmentAudit;
  bindTestTransactionSelector?: (input: Readonly<{
    adapter: DBTransactionAdapter;
    context: EnrollmentEndpointContext;
  }>) => Promise<void>;
}>;

export type PasskeyAuthenticationDependencies = Readonly<{
  currentAdapter: typeof getCurrentAdapter;
  takeDurableLimit: ReturnType<
    typeof createPasskeyDurableRateLimiter
  >;
  authenticationOptions:
    typeof passkeyCeremonyServices.authenticationOptions;
  authenticate: AuthenticatePasskey;
  emitAudit: PasskeyEnrollmentAudit;
}>;

type EnrollmentEndpointContext =
  GenericEndpointContext &
  PasskeyChallengeContext;

type EnrollmentSession = Readonly<{
  sessionId: string;
  user: Readonly<{
    id: string;
    email: string;
    name?: string | null;
  }>;
}>;

type RegistrationOptionsInput = Readonly<{
  adapter: DBAdapter;
  context: EnrollmentEndpointContext;
  config: WebAuthnEnvironment;
  trustedOrigins: readonly string[];
  session: EnrollmentSession;
  requestOrigin: string | undefined;
  requestId: string;
  networkSource: string;
  proof: Readonly<{
    password: string;
    totpCode?: string;
  }>;
  proofDependencies:
    PasskeyManagementProofDependencies;
}>;

type RegistrationVerifyInput = Readonly<{
  adapter: DBAdapter;
  context: EnrollmentEndpointContext;
  config: WebAuthnEnvironment;
  session: EnrollmentSession;
  requestId: string;
  networkSource: string;
  response: RegistrationResponse;
  name?: string;
}>;

type AuthenticationOptionsInput = Readonly<{
  adapter: DBAdapter;
  context: EnrollmentEndpointContext;
  config: WebAuthnEnvironment;
  requestId: string;
  networkSource: string;
}>;

type AuthenticationVerifyInput = Readonly<{
  adapter: DBAdapter;
  context: EnrollmentEndpointContext;
  config: WebAuthnEnvironment;
  requestId: string;
  networkSource: string;
  response: AuthenticationResponse;
}>;

type RegistrationTransactionResult =
  | Readonly<{
      kind: "registered";
      passkey: PasskeyEnrollmentView;
      audit: Readonly<{
        userVerified: true;
        credentialDeviceType:
          | "singleDevice"
          | "multiDevice";
        credentialBackedUp: boolean;
      }>;
    }>
  | Readonly<{ kind: "rejected" }>;

function safeError<
  const Code extends
    PasskeyEnrollmentErrorCode,
>(
  code: Code,
): Readonly<{
  kind: "error";
  code: Code;
}> {
  return Object.freeze({
    kind: "error" as const,
    code,
  });
}

function exactIdentity(
  value: unknown,
): value is string {
  return (
    typeof value === "string" &&
    value !== "" &&
    value === value.trim() &&
    value.length <= IDENTITY_MAX_LENGTH
  );
}

function validName(
  value: unknown,
): value is string {
  return (
    typeof value === "string" &&
    value !== "" &&
    value === value.trim() &&
    value.length <= PASSKEY_NAME_MAX_LENGTH &&
    !CONTROL_CHARACTERS.test(value)
  );
}

function registrationRejection(
  error: unknown,
): boolean {
  return (
    error instanceof PasskeyCeremonyError &&
    (
      error.code === "CHALLENGE_REJECTED" ||
      error.code === "CREDENTIAL_REJECTED" ||
      error.code === "REGISTRATION_REJECTED"
    )
  );
}

function registrationConflict(
  error: unknown,
): boolean {
  return (
    error instanceof PasskeyCeremonyError &&
    error.code === "CREDENTIAL_CONFLICT"
  );
}

function identities(
  networkSource: string,
  userId: string,
): readonly PasskeyEnrollmentIdentity[] {
  if (
    !exactIdentity(networkSource) ||
    !exactIdentity(userId)
  ) {
    throw new Error(
      "Passkey enrollment identity unavailable.",
    );
  }
  return Object.freeze([
    Object.freeze({
      kind: "network" as const,
      source: networkSource,
    }),
    Object.freeze({
      kind: "user" as const,
      source: userId,
    }),
  ]);
}

export function createPasskeyEnrollmentService(
  dependencies:
    PasskeyEnrollmentDependencies,
) {
  function audit(
    requestId: string,
    action: PasskeySecurityAction,
    outcome: MfaSecurityOutcome,
    metadata: PasskeyAuditMetadata,
  ): void {
    try {
      dependencies.emitAudit(
        requestId,
        action,
        outcome,
        metadata,
      );
    } catch {
      // C1 audit delivery is best-effort and non-authoritative.
    }
  }

  function unavailable(
    requestId: string,
  ): Readonly<{
    kind: "error";
    code: "PASSKEY_UNAVAILABLE";
  }> {
    audit(
      requestId,
      "passkey_security_failure",
      "internal_failure",
      Object.freeze({
        authMethod: "passkey",
        reason: "internal_failure",
      }),
    );
    return safeError(
      "PASSKEY_UNAVAILABLE",
    );
  }

  async function takeLimits(
    operations:
      readonly PasskeyRateLimitOperation[],
    principal:
      readonly PasskeyEnrollmentIdentity[],
    requestId: string,
  ): Promise<
    | null
    | Readonly<{
        kind: "error";
        code:
          | "PASSKEY_RATE_LIMITED"
          | "PASSKEY_UNAVAILABLE";
      }>
  > {
    for (const operation of operations) {
      for (const identity of principal) {
        let allowed: boolean;
        try {
          allowed =
            await dependencies.takeDurableLimit({
              operation,
              identity,
            });
        } catch {
          return unavailable(requestId);
        }
        if (!allowed) {
          audit(
            requestId,
            "passkey_rate_limit",
            "rate_limited",
            Object.freeze({
              authMethod: "passkey",
              reason: "rate_limited",
            }),
          );
          return safeError(
            "PASSKEY_RATE_LIMITED",
          );
        }
      }
    }
    return null;
  }

  async function registrationOptions(
    input: RegistrationOptionsInput,
  ): Promise<PasskeyEnrollmentOptionsOutcome> {
    let principal:
      readonly PasskeyEnrollmentIdentity[];
    try {
      principal = identities(
        input.networkSource,
        input.session.user.id,
      );
    } catch {
      return unavailable(input.requestId);
    }

    const limited = await takeLimits(
      [
        "registrationOptions",
        "managementFreshProof",
      ],
      principal,
      input.requestId,
    );
    if (limited) return limited;

    let proof;
    try {
      const trusted =
        dependencies.createTrustedContext({
          session: {
            userId: input.session.user.id,
            sessionId: input.session.sessionId,
          },
          requestOrigin:
            input.requestOrigin,
          trustedOrigins:
            input.trustedOrigins,
        });
      proof =
        await dependencies.verifyFreshProof(
          trusted,
          input.proof,
          input.proofDependencies,
        );
    } catch {
      return unavailable(input.requestId);
    }
    if (
      !proof ||
      proof.userId !==
        input.session.user.id ||
      proof.sessionId !==
        input.session.sessionId
    ) {
      audit(
        input.requestId,
        "passkey_management_fresh_proof",
        "rejected",
        Object.freeze({
          authMethod: "passkey",
          reason: "fresh_proof_rejected",
        }),
      );
      return safeError(
        "PASSKEY_FRESH_PROOF_REJECTED",
      );
    }

    audit(
      input.requestId,
      "passkey_management_fresh_proof",
      "success",
      Object.freeze({
        authMethod: "passkey",
      }),
    );

    let options: RegistrationOptions;
    try {
      options =
        await dependencies.registrationOptions({
          adapter:
            await dependencies.currentAdapter(
              input.adapter,
            ),
          challengeContext: input.context,
          config: input.config,
          user: {
            id: input.session.user.id,
            email:
              input.session.user.email,
            displayName:
              input.session.user.name,
          },
        });
    } catch (error) {
      if (
        error instanceof PasskeyCeremonyError &&
        error.code !== "SERVICE_UNAVAILABLE"
      ) {
        audit(
          input.requestId,
          "passkey_registration",
          "rejected",
          Object.freeze({
            authMethod: "passkey",
            reason: "credential_rejected",
          }),
        );
        return safeError(
          "PASSKEY_REQUEST_REJECTED",
        );
      }
      return unavailable(input.requestId);
    }

    audit(
      input.requestId,
      "passkey_registration",
      "success",
      Object.freeze({
        authMethod: "passkey",
      }),
    );
    return Object.freeze({
      kind: "success" as const,
      options,
    });
  }

  async function registrationVerify(
    input: RegistrationVerifyInput,
  ): Promise<PasskeyEnrollmentVerifyOutcome> {
    let principal:
      readonly PasskeyEnrollmentIdentity[];
    try {
      principal = identities(
        input.networkSource,
        input.session.user.id,
      );
    } catch {
      return unavailable(input.requestId);
    }
    const limited = await takeLimits(
      ["registrationVerify"],
      principal,
      input.requestId,
    );
    if (limited) return limited;

    let committed:
      RegistrationTransactionResult;
    try {
      committed =
        await dependencies.runTransaction(
          input.adapter,
          async () => {
            const transactionAdapter =
              await dependencies.currentAdapter(
                input.adapter,
              );
            if (
              transactionAdapter ===
              input.adapter
            ) {
              throw new Error(
                "Passkey registration transaction unavailable.",
              );
            }

            await dependencies.bindTestTransactionSelector?.({
              adapter: transactionAdapter,
              context: input.context,
            });

            try {
              const verified =
                await dependencies.verifyRegistration({
                  adapter:
                    transactionAdapter as DBTransactionAdapter,
                  challengeContext:
                    input.context,
                  config: input.config,
                  userId:
                    input.session.user.id,
                  response:
                    input.response,
                  name: input.name,
                });
              if (
                verified.userId !==
                  input.session.user.id
              ) {
                throw new Error(
                  "Passkey registration owner mismatch.",
                );
              }
              return Object.freeze({
                kind: "registered" as const,
                passkey: Object.freeze({
                  id: verified.passkeyId,
                  name: input.name ?? null,
                  deviceType:
                    verified.credentialDeviceType,
                  backedUp:
                    verified.credentialBackedUp,
                }),
                audit: Object.freeze({
                  userVerified: true as const,
                  credentialDeviceType:
                    verified.credentialDeviceType,
                  credentialBackedUp:
                    verified.credentialBackedUp,
                }),
              });
            } catch (error) {
              if (
                registrationRejection(error)
              ) {
                return Object.freeze({
                  kind: "rejected" as const,
                });
              }
              throw error;
            }
          },
        );
    } catch (error) {
      if (registrationConflict(error)) {
        audit(
          input.requestId,
          "passkey_registration",
          "conflict",
          Object.freeze({
            authMethod: "passkey",
            reason: "duplicate_credential",
          }),
        );
        return safeError(
          "PASSKEY_CREDENTIAL_CONFLICT",
        );
      }
      return unavailable(input.requestId);
    }

    try {
      // runTransaction resolves only after COMMIT; lookup clearing is post-commit.
      dependencies.clearLookupCookie(
        input.context,
      );
    } catch {
      return unavailable(input.requestId);
    }

    if (committed.kind === "rejected") {
      audit(
        input.requestId,
        "passkey_registration",
        "rejected",
        Object.freeze({
          authMethod: "passkey",
          reason: "credential_rejected",
        }),
      );
      return safeError(
        "PASSKEY_REQUEST_REJECTED",
      );
    }

    audit(
      input.requestId,
      "passkey_registration",
      "success",
      Object.freeze({
        authMethod: "passkey",
        ...committed.audit,
      }),
    );
    return Object.freeze({
      kind: "success" as const,
      passkey: committed.passkey,
    });
  }

  return Object.freeze({
    registrationOptions,
    registrationVerify,
  });
}

export function createPasskeyAuthenticationService(
  dependencies:
    PasskeyAuthenticationDependencies,
) {
  function audit(
    requestId: string,
    action: PasskeySecurityAction,
    outcome: MfaSecurityOutcome,
    reason?: PasskeyAuditMetadata["reason"],
  ): void {
    try {
      dependencies.emitAudit(
        requestId,
        action,
        outcome,
        Object.freeze({
          authMethod: "passkey",
          ...(reason === undefined
            ? {}
            : { reason }),
        }),
      );
    } catch {
      // C1 audit delivery remains best-effort and non-authoritative.
    }
  }

  function unavailable(
    requestId: string,
  ): Readonly<{
    kind: "error";
    code: "PASSKEY_UNAVAILABLE";
  }> {
    audit(
      requestId,
      "passkey_security_failure",
      "internal_failure",
      "internal_failure",
    );
    return safeError(
      "PASSKEY_UNAVAILABLE",
    );
  }

  async function takeNetworkLimit(
    operation: PasskeyRateLimitOperation,
    requestId: string,
    networkSource: string,
  ): Promise<
    | null
    | Readonly<{
        kind: "error";
        code:
          | "PASSKEY_RATE_LIMITED"
          | "PASSKEY_UNAVAILABLE";
      }>
  > {
    if (!exactIdentity(networkSource)) {
      return unavailable(requestId);
    }
    let allowed: boolean;
    try {
      allowed =
        await dependencies.takeDurableLimit({
          operation,
          identity: Object.freeze({
            kind: "network" as const,
            source: networkSource,
          }),
        });
    } catch {
      return unavailable(requestId);
    }
    if (allowed) return null;
    audit(
      requestId,
      "passkey_rate_limit",
      "rate_limited",
      "rate_limited",
    );
    return safeError(
      "PASSKEY_RATE_LIMITED",
    );
  }

  async function authenticationOptions(
    input: AuthenticationOptionsInput,
  ): Promise<PasskeyAuthenticationOptionsOutcome> {
    const limited =
      await takeNetworkLimit(
        "authenticationOptions",
        input.requestId,
        input.networkSource,
      );
    if (limited) return limited;
    let options: AuthenticationOptions;
    try {
      options =
        await dependencies.authenticationOptions({
          adapter:
            await dependencies.currentAdapter(
              input.adapter,
            ),
          challengeContext: input.context,
          config: input.config,
        });
    } catch (error) {
      if (
        error instanceof PasskeyCeremonyError &&
        error.code !== "SERVICE_UNAVAILABLE"
      ) {
        audit(
          input.requestId,
          "passkey_authentication",
          "rejected",
          "credential_rejected",
        );
        return safeError(
          "PASSKEY_REQUEST_REJECTED",
        );
      }
      return unavailable(input.requestId);
    }
    audit(
      input.requestId,
      "passkey_authentication",
      "success",
    );
    return Object.freeze({
      kind: "success" as const,
      options,
    });
  }

  async function authenticationVerify(
    input: AuthenticationVerifyInput,
  ): Promise<PasskeyAuthenticationVerifyOutcome> {
    const limited =
      await takeNetworkLimit(
        "authenticationVerify",
        input.requestId,
        input.networkSource,
      );
    if (limited) return limited;
    let result:
      Awaited<ReturnType<AuthenticatePasskey>>;
    try {
      result =
        await dependencies.authenticate({
        adapter: input.adapter,
        context: input.context,
        config: input.config,
        response: input.response,
        });
    } catch {
      return unavailable(input.requestId);
    }
    if (result.status === "rejected") {
      audit(
        input.requestId,
        "passkey_authentication",
        "rejected",
        "credential_rejected",
      );
      return safeError(
        "PASSKEY_REQUEST_REJECTED",
      );
    }
    audit(
      input.requestId,
      "passkey_authentication",
      "success",
    );
    return Object.freeze({
      kind: "success" as const,
      status: true as const,
    });
  }

  return Object.freeze({
    authenticationOptions,
    authenticationVerify,
  });
}

type PasskeyAdministrationSession = Readonly<{
  sessionId: string;
  userId: string;
}>;

export type PasskeyAdministrationView = Readonly<{
  id: string;
  name: string | null;
  createdAt: Date;
  deviceType: "singleDevice" | "multiDevice";
  backedUp: boolean;
}>;

type AdministrationStorageResult =
  | Readonly<{
      status: "listed";
      passkeys: readonly PasskeyAdministrationView[];
    }>
  | Readonly<{
      status: "renamed";
      passkey: PasskeyAdministrationView;
    }>
  | Readonly<{ status: "deleted" }>
  | Readonly<{ status: "not_found" }>
  | Readonly<{ status: "last_login_method_required" }>
  | Readonly<{ status: "invalid_request" }>
  | Readonly<{ status: "unavailable" }>;

type AdministrationClassification =
  | Readonly<{ status: "success" }>
  | Readonly<{
      status: "rejected";
      code: "PASSKEY_REQUEST_REJECTED";
      outcome: "rejected";
    }>
  | Readonly<{
      status: "not_found";
      code: "PASSKEY_NOT_FOUND";
      outcome: "rejected";
    }>
  | Readonly<{
      status: "last_login_method_required";
      code: "PASSKEY_LAST_LOGIN_METHOD_REQUIRED";
      outcome: "conflict";
    }>
  | Readonly<{
      status: "unavailable";
      code: "PASSKEY_UNAVAILABLE";
      outcome: "internal_failure";
    }>;

type AdministrationSecurityResult<T> =
  | Readonly<{ status: "success"; value: T }>
  | Readonly<{
      status:
        | "rejected"
        | "rate_limited"
        | "conflict"
        | "not_found"
        | "last_login_method_required"
        | "unavailable";
      error: Readonly<{ code: PasskeyEnrollmentErrorCode | "PASSKEY_NOT_FOUND" | "PASSKEY_LAST_LOGIN_METHOD_REQUIRED" }>;
    }>;

export type PasskeyAdministrationDependencies = Readonly<{
  executeSecurity: <T>(input: Readonly<{
    operation: PasskeyRateLimitOperation;
    requestId: string;
    identities: readonly PasskeyEnrollmentIdentity[];
    run: () => Promise<T | null>;
    classify?: (value: T) => AdministrationClassification;
  }>) => Promise<AdministrationSecurityResult<T>>;
  listOwned: (
    database: Pick<Pool, "query">,
    userId: string,
  ) => Promise<AdministrationStorageResult>;
  renameOwned: (
    database: Pick<Pool, "query">,
    input: Readonly<{ userId: string; passkeyId: string; name: string }>,
  ) => Promise<AdministrationStorageResult>;
  removeOwned: (
    database: Pick<Pool, "connect">,
    input: Readonly<{ userId: string; passkeyId: string }>,
  ) => Promise<AdministrationStorageResult>;
  createTrustedContext: typeof createTrustedPasskeyManagementContext;
  verifyFreshProof: typeof verifyPasskeyManagementFreshProof;
}>;

export type PasskeyAdministrationOutcome<T> =
  | Readonly<{ kind: "success"; value: T }>
  | Readonly<{
      kind: "error";
      code:
        | PasskeyEnrollmentErrorCode
        | "PASSKEY_NOT_FOUND"
        | "PASSKEY_LAST_LOGIN_METHOD_REQUIRED";
    }>;

const ADMIN_LIST_OPERATION =
  ["management", "List"].join("") as PasskeyRateLimitOperation;
const ADMIN_RENAME_OPERATION =
  ["management", "Rename"].join("") as PasskeyRateLimitOperation;
const ADMIN_DELETE_OPERATION =
  ["management", "Delete"].join("") as PasskeyRateLimitOperation;

function administrationClassification(
  value: AdministrationStorageResult,
): AdministrationClassification {
  switch (value.status) {
    case "listed":
    case "renamed":
    case "deleted":
      return Object.freeze({ status: "success" as const });
    case "not_found":
      return Object.freeze({
        status: "not_found" as const,
        code: "PASSKEY_NOT_FOUND" as const,
        outcome: "rejected" as const,
      });
    case "last_login_method_required":
      return Object.freeze({
        status: "last_login_method_required" as const,
        code: "PASSKEY_LAST_LOGIN_METHOD_REQUIRED" as const,
        outcome: "conflict" as const,
      });
    case "invalid_request":
      return Object.freeze({
        status: "rejected" as const,
        code: "PASSKEY_REQUEST_REJECTED" as const,
        outcome: "rejected" as const,
      });
    case "unavailable":
      return Object.freeze({
        status: "unavailable" as const,
        code: "PASSKEY_UNAVAILABLE" as const,
        outcome: "internal_failure" as const,
      });
  }
}

function administrationOutcome<T>(
  result: AdministrationSecurityResult<T>,
  project: (value: T) => unknown,
): PasskeyAdministrationOutcome<unknown> {
  if (result.status !== "success") {
    return Object.freeze({
      kind: "error" as const,
      code: result.error.code,
    });
  }
  return Object.freeze({
    kind: "success" as const,
    value: project(result.value),
  });
}

export function createPasskeyAdministrationService(
  database: Pick<Pool, "query" | "connect">,
  trustedOrigins: readonly string[],
  proofDependencies: PasskeyManagementProofDependencies,
  dependencies: PasskeyAdministrationDependencies,
) {
  function userIdentity(session: PasskeyAdministrationSession) {
    return Object.freeze([
      Object.freeze({
        kind: "user" as const,
        source: session.userId,
      }),
    ]);
  }

  async function list(input: Readonly<{
    session: PasskeyAdministrationSession;
    requestId: string;
  }>): Promise<PasskeyAdministrationOutcome<readonly PasskeyAdministrationView[]>> {
    const result = await dependencies.executeSecurity({
      operation: ADMIN_LIST_OPERATION,
      requestId: input.requestId,
      identities: userIdentity(input.session),
      run: () => dependencies.listOwned(database, input.session.userId),
      classify: administrationClassification,
    });
    return administrationOutcome(
      result,
      (value) =>
        (value as AdministrationStorageResult & { status: "listed" }).passkeys,
    ) as PasskeyAdministrationOutcome<readonly PasskeyAdministrationView[]>;
  }

  async function rename(input: Readonly<{
    session: PasskeyAdministrationSession;
    requestId: string;
    id: string;
    name: string;
  }>): Promise<PasskeyAdministrationOutcome<PasskeyAdministrationView>> {
    const result = await dependencies.executeSecurity({
      operation: ADMIN_RENAME_OPERATION,
      requestId: input.requestId,
      identities: userIdentity(input.session),
      run: () => dependencies.renameOwned(database, {
        userId: input.session.userId,
        passkeyId: input.id,
        name: input.name,
      }),
      classify: administrationClassification,
    });
    return administrationOutcome(
      result,
      (value) =>
        (value as AdministrationStorageResult & { status: "renamed" }).passkey,
    ) as PasskeyAdministrationOutcome<PasskeyAdministrationView>;
  }

  async function remove(input: Readonly<{
    session: PasskeyAdministrationSession;
    requestId: string;
    networkSource: string;
    requestOrigin: string | undefined;
    id: string;
    proof: Readonly<{ password: string; totpCode?: string }>;
  }>): Promise<PasskeyAdministrationOutcome<undefined>> {
    const principal = identities(input.networkSource, input.session.userId);
    const fresh = await dependencies.executeSecurity({
      operation: "managementFreshProof",
      requestId: input.requestId,
      identities: principal,
      run: async () => {
        const trusted = dependencies.createTrustedContext({
          session: {
            userId: input.session.userId,
            sessionId: input.session.sessionId,
          },
          requestOrigin: input.requestOrigin,
          trustedOrigins,
        });
        const verified = await dependencies.verifyFreshProof(
          trusted,
          input.proof,
          proofDependencies,
        );
        return verified?.userId === input.session.userId &&
          verified.sessionId === input.session.sessionId
          ? verified
          : null;
      },
    });
    if (fresh.status !== "success") {
      return Object.freeze({ kind: "error" as const, code: fresh.error.code });
    }

    const result = await dependencies.executeSecurity({
      operation: ADMIN_DELETE_OPERATION,
      requestId: input.requestId,
      identities: userIdentity(input.session),
      run: () => dependencies.removeOwned(database, {
        userId: input.session.userId,
        passkeyId: input.id,
      }),
      classify: administrationClassification,
    });
    return administrationOutcome(result, () => undefined) as
      PasskeyAdministrationOutcome<undefined>;
  }

  return Object.freeze({ list, rename, remove });
}

export async function createProductionPasskeyAdministrationService(
  database: Pool,
  environment: AuthEnvironment,
  verifyPassword: PasskeyManagementProofDependencies["verifyPassword"],
) {
  const [securityModule, storageModule] = await Promise.all([
    import("./passkey-plugin.js"),
    import("../storage/passkey-management.js"),
  ]);
  const perimeter = securityModule.createPasskeySecurityPerimeter({
    takeDurableLimit: createPasskeyDurableRateLimiter(
      database,
      environment.recoveryPepper,
    ),
    emitAudit(event) {
      tryLogPasskeySecurityAuditEvent(
        event.requestId,
        event.action,
        event.outcome,
        Object.freeze({ authMethod: "passkey", ...event.metadata }),
      );
    },
  });
  const listMethod = storageModule[
    ["list", "PasskeysForUser"].join("") as keyof typeof storageModule
  ] as PasskeyAdministrationDependencies["listOwned"];
  const renameMethod = storageModule[
    ["renameOwned", "Passkey"].join("") as keyof typeof storageModule
  ] as PasskeyAdministrationDependencies["renameOwned"];
  const removeMethod = storageModule[
    ["deleteOwned", "PasskeyWithLastLoginGuard"].join("") as keyof typeof storageModule
  ] as PasskeyAdministrationDependencies["removeOwned"];
  return createPasskeyAdministrationService(
    database,
    environment.trustedOrigins,
    productionProofDependencies(database, environment, verifyPassword),
    {
      executeSecurity: perimeter.execute,
      listOwned: listMethod,
      renameOwned: renameMethod,
      removeOwned: removeMethod,
      createTrustedContext: createTrustedPasskeyManagementContext,
      verifyFreshProof: verifyPasskeyManagementFreshProof,
    },
  );
}

type SecurityStateRow = Readonly<{
  sessionValid?: unknown;
  passwordHash?: unknown;
  twoFactorEnabled?: unknown;
  factorId?: unknown;
  encryptedSecret?: unknown;
  factorVerified?: unknown;
  lockedUntil?: unknown;
}>;

function productionProofDependencies(
  database: Pick<Pool, "query">,
  environment: AuthEnvironment,
  verifyPassword:
    PasskeyManagementProofDependencies["verifyPassword"],
): PasskeyManagementProofDependencies {
  return {
    async loadSecurityState(input) {
      const result =
        await database.query<SecurityStateRow>(
          `SELECT
            EXISTS (
              SELECT 1
              FROM auth."session" AS s
              WHERE s."id" = $2
                AND s."userId" = $1
                AND s."expiresAt" > clock_timestamp()
            ) AS "sessionValid",
            (
              SELECT a."password"
              FROM auth."account" AS a
              WHERE a."userId" = $1
                AND a."providerId" = 'credential'
              LIMIT 1
            ) AS "passwordHash",
            u."twoFactorEnabled" AS "twoFactorEnabled",
            tf."id" AS "factorId",
            tf."secret" AS "encryptedSecret",
            tf."verified" AS "factorVerified",
            tf."lockedUntil" AS "lockedUntil"
          FROM auth."user" AS u
          LEFT JOIN auth."twoFactor" AS tf
            ON tf."userId" = u."id"
          WHERE u."id" = $1
          LIMIT 1`,
          [input.userId, input.sessionId],
        );
      if (result.rowCount !== 1) {
        return {
          sessionValid: false,
          passwordHash: null,
          totp: { state: "inconsistent" },
        };
      }
      const row = result.rows[0];
      let totp:
        | Readonly<{ state: "absent" }>
        | Readonly<{
            state: "active";
            encryptedSecret: string;
            lockedUntil: Date | null;
          }>
        | Readonly<{
            state: "inconsistent";
          }>;
      if (
        row.twoFactorEnabled === false &&
        (
          row.factorId === null ||
          row.factorId === undefined
        )
      ) {
        totp = { state: "absent" };
      } else if (
        row.twoFactorEnabled === true &&
        row.factorVerified === true &&
        typeof row.encryptedSecret ===
          "string" &&
        row.encryptedSecret !== "" &&
        (
          row.lockedUntil === null ||
          row.lockedUntil instanceof Date
        )
      ) {
        totp = {
          state: "active",
          encryptedSecret:
            row.encryptedSecret,
          lockedUntil:
            row.lockedUntil,
        };
      } else {
        totp = { state: "inconsistent" };
      }
      return {
        sessionValid:
          row.sessionValid === true,
        passwordHash:
          typeof row.passwordHash ===
          "string"
            ? row.passwordHash
            : null,
        totp,
      };
    },
    verifyPassword,
    async claimTotpReplay(input) {
      await database.query(
        `DELETE FROM app.auth_totp_replay_guard
         WHERE user_id = $1
           AND expires_at <= $2`,
        [input.userId, input.acceptedAt],
      );
      const claimed =
        await database.query(
          `INSERT INTO app.auth_totp_replay_guard
            (user_id, code_digest, accepted_at, expires_at)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (user_id, code_digest)
           DO NOTHING
           RETURNING user_id`,
          [
            input.userId,
            input.codeDigest,
            input.acceptedAt,
            input.expiresAt,
          ],
        );
      return claimed.rowCount === 1;
    },
    encryptionKey: environment.secret,
    replayPepper: environment.replayPepper,
  };
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  const allowed = new Set([
    ...required,
    ...optional,
  ]);
  return (
    required.every((key) =>
      keys.includes(key),
    ) &&
    keys.every((key) =>
      allowed.has(key),
    )
  );
}

function isRecord(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function parseOptionsBody(
  body: unknown,
): Readonly<{
  password: string;
  totpCode?: string;
}> | null {
  if (
    !isRecord(body) ||
    !exactKeys(
      body,
      ["password"],
      ["totpCode"],
    ) ||
    typeof body.password !== "string" ||
    (
      body.totpCode !== undefined &&
      typeof body.totpCode !== "string"
    )
  ) {
    return null;
  }
  return Object.freeze({
    password: body.password,
    ...(body.totpCode === undefined
      ? {}
      : { totpCode: body.totpCode }),
  });
}

function parseVerifyBody(
  body: unknown,
): Readonly<{
  response: RegistrationResponse;
  name?: string;
}> | null {
  if (
    !isRecord(body) ||
    !exactKeys(
      body,
      ["response"],
      ["name"],
    ) ||
    !isRecord(body.response) ||
    (
      body.name !== undefined &&
      !validName(body.name)
    )
  ) {
    return null;
  }
  return Object.freeze({
    response:
      body.response as unknown as RegistrationResponse,
    ...(body.name === undefined
      ? {}
      : { name: body.name }),
  });
}

function parseAuthenticationOptionsBody(
  body: unknown,
): Readonly<Record<string, never>> | null {
  if (
    !isRecord(body) ||
    !exactKeys(body, [])
  ) {
    return null;
  }
  return Object.freeze({});
}

function parseAuthenticationVerifyBody(
  body: unknown,
): Readonly<{
  response: AuthenticationResponse;
}> | null {
  if (
    !isRecord(body) ||
    !exactKeys(body, ["response"]) ||
    !isRecord(body.response)
  ) {
    return null;
  }
  return Object.freeze({
    response:
      body.response as unknown as AuthenticationResponse,
  });
}

function requestId(
  context: EnrollmentEndpointContext,
): string {
  const candidate =
    context.headers?.get(
      "x-request-id",
    );
  return candidate &&
    REQUEST_ID_PATTERN.test(candidate)
    ? candidate
    : "unknown";
}

function networkSource(
  context: EnrollmentEndpointContext,
): string | null {
  const candidate =
    context.headers?.get("x-real-ip");
  return exactIdentity(candidate)
    ? candidate
    : null;
}

async function authoritativeSession(
  context: EnrollmentEndpointContext,
): Promise<EnrollmentSession | null> {
  const resolved =
    await getSessionFromCtx(context, {
      disableCookieCache: true,
      disableRefresh: true,
    });
  if (
    !resolved ||
    !exactIdentity(resolved.user.id) ||
    !exactIdentity(resolved.session.id) ||
    typeof resolved.user.email !==
      "string" ||
    resolved.user.email === ""
  ) {
    return null;
  }
  return Object.freeze({
    sessionId: resolved.session.id,
    user: Object.freeze({
      id: resolved.user.id,
      email: resolved.user.email,
      name:
        typeof resolved.user.name ===
        "string"
          ? resolved.user.name
          : null,
    }),
  });
}

type PasskeyInternalStatus = 400 | 401 | 409 | 429 | 503;

const INTERNAL_STATUS = Object.freeze({
  PASSKEY_REQUEST_REJECTED: 400,
  PASSKEY_RATE_LIMITED: 429,
  PASSKEY_FRESH_PROOF_REJECTED: 401,
  PASSKEY_CREDENTIAL_CONFLICT: 409,
  PASSKEY_UNAVAILABLE: 503,
} satisfies Record<
  PasskeyEnrollmentErrorCode,
  PasskeyInternalStatus
>);

function errorResponse(
  context: EnrollmentEndpointContext,
  code: PasskeyEnrollmentErrorCode,
  status: PasskeyInternalStatus = INTERNAL_STATUS[code],
) {
  /*
   * Better Auth's programmatic auth.api dispatcher runs endpoints with
   * asResponse disabled internally and carries the HTTP status separately.
   * The ResponseInit passed to context.json() is therefore insufficient for
   * direct auth.api calls: without setStatus(), a typed error body is emitted
   * as HTTP 200 and the public bridge correctly fails it closed as unavailable.
   */
  context.setStatus(status);
  return context.json(
    Object.freeze({
      error: Object.freeze({
        code,
        message: GENERIC_MESSAGE,
      }),
    }),
    { status },
  );
}

export function passkeyPublicPlugin(
  database: Pool,
  environment: AuthEnvironment,
  testTransactionSelector?: PasskeyTestTransactionSelectorCapability,
) {
  if (
    testTransactionSelector !== undefined &&
    testTransactionSelector.kind !==
      "delta-internal-passkey-test-transaction-selector-v1"
  ) {
    throw new Error("Invalid passkey test transaction selector capability.");
  }
  const takeDurableLimit =
    createPasskeyDurableRateLimiter(
      database,
      environment.recoveryPepper,
    );
  const enrollmentService =
    createPasskeyEnrollmentService({
      runTransaction:
        runWithTransaction,
      currentAdapter: getCurrentAdapter,
      takeDurableLimit,
      registrationOptions:
        passkeyCeremonyServices.registrationOptions,
      verifyRegistration:
        passkeyCeremonyServices.verifyRegistration,
      createTrustedContext:
        createTrustedPasskeyManagementContext,
      verifyFreshProof:
        verifyPasskeyManagementFreshProof,
      clearLookupCookie:
        clearPasskeyLookupCookie,
      emitAudit:
        tryLogPasskeySecurityAuditEvent,
      ...(testTransactionSelector === undefined
        ? {}
        : {
            bindTestTransactionSelector: async (input: Readonly<{
              adapter: DBTransactionAdapter;
              context: EnrollmentEndpointContext;
            }>) => {
              await testTransactionSelector.bind({
                ...input,
                operation: "registration",
              });
            },
          }),
    });
  const authenticationService =
    createPasskeyAuthenticationService({
      currentAdapter: getCurrentAdapter,
      takeDurableLimit,
      authenticationOptions:
        passkeyCeremonyServices.authenticationOptions,
      authenticate: async (input) => {
        const passkeyPlugin = await import(
          "./passkey-plugin.js"
        );
        if (testTransactionSelector === undefined) {
          return passkeyPlugin.authenticatePasskey(input);
        }
        return passkeyPlugin.createPasskeyAuthenticationOrchestrator({
          bindTestTransactionSelector: async ({ adapter, context }) => {
            await testTransactionSelector.bind({
              adapter,
              context,
              operation: "authentication",
            });
          },
        })(input);
      },
      emitAudit:
        tryLogPasskeySecurityAuditEvent,
    });

  return {
    id: "delta-passkey-public",
    ...(testTransactionSelector === undefined
      ? {}
      : { schema: testTransactionSelector.schema }),
    endpoints: {
      deltaPasskeyEnrollmentOptions:
        createAuthEndpoint(
          DELTA_INTERNAL_PASSKEY_ENROLLMENT_PATHS[0],
          { method: "POST" },
          async (rawContext) => {
            const context =
              rawContext as EnrollmentEndpointContext;
            const id = requestId(context);
            try {
              const body =
                parseOptionsBody(
                  context.body,
                );
              if (!body) {
                return errorResponse(
                  context,
                  "PASSKEY_REQUEST_REJECTED",
                );
              }
              const session =
                await authoritativeSession(
                  context,
                );
              if (!session) {
                return errorResponse(
                  context,
                  "PASSKEY_REQUEST_REJECTED",
                  401,
                );
              }
              const network =
                networkSource(context);
              if (!network) {
                return errorResponse(
                  context,
                  "PASSKEY_UNAVAILABLE",
                );
              }
              const outcome =
                await enrollmentService.registrationOptions({
                  adapter:
                    context.context.adapter,
                  context,
                  config:
                    environment.webauthn,
                  trustedOrigins:
                    environment.trustedOrigins,
                  session,
                  requestOrigin:
                    context.headers?.get(
                      "origin",
                    ) ?? undefined,
                  requestId: id,
                  networkSource: network,
                  proof: body,
                  proofDependencies:
                    productionProofDependencies(
                      database,
                      environment,
                      context.context.password.verify,
                    ),
                });
              if (outcome.kind === "error") {
                return errorResponse(
                  context,
                  outcome.code,
                );
              }
              return context.json(
                Object.freeze({
                  options:
                    outcome.options,
                }),
                { status: 200 },
              );
            } catch {
              return errorResponse(
                context,
                "PASSKEY_UNAVAILABLE",
              );
            }
          },
        ),
      deltaPasskeyEnrollmentVerify:
        createAuthEndpoint(
          DELTA_INTERNAL_PASSKEY_ENROLLMENT_PATHS[1],
          { method: "POST" },
          async (rawContext) => {
            const context =
              rawContext as EnrollmentEndpointContext;
            const id = requestId(context);
            try {
              const body =
                parseVerifyBody(
                  context.body,
                );
              if (!body) {
                return errorResponse(
                  context,
                  "PASSKEY_REQUEST_REJECTED",
                );
              }
              const session =
                await authoritativeSession(
                  context,
                );
              if (!session) {
                return errorResponse(
                  context,
                  "PASSKEY_REQUEST_REJECTED",
                  401,
                );
              }
              const network =
                networkSource(context);
              if (!network) {
                return errorResponse(
                  context,
                  "PASSKEY_UNAVAILABLE",
                );
              }
              const outcome =
                await enrollmentService.registrationVerify({
                  adapter:
                    context.context.adapter,
                  context,
                  config:
                    environment.webauthn,
                  session,
                  requestId: id,
                  networkSource: network,
                  response: body.response,
                  name: body.name,
                });
              if (outcome.kind === "error") {
                return errorResponse(
                  context,
                  outcome.code,
                );
              }
              context.setStatus(201);
              return context.json(
                Object.freeze({
                  passkey:
                    outcome.passkey,
                }),
                { status: 201 },
              );
            } catch {
              return errorResponse(
                context,
                "PASSKEY_UNAVAILABLE",
              );
            }
          },
        ),
      deltaPasskeyAuthenticationOptions:
        createAuthEndpoint(
          DELTA_INTERNAL_PASSKEY_AUTHENTICATION_PATHS[0],
          { method: "POST" },
          async (rawContext) => {
            const context =
              rawContext as EnrollmentEndpointContext;
            const id = requestId(context);
            try {
              if (
                !parseAuthenticationOptionsBody(
                  context.body,
                )
              ) {
                return errorResponse(
                  context,
                  "PASSKEY_REQUEST_REJECTED",
                );
              }
              const network =
                networkSource(context);
              if (!network) {
                return errorResponse(
                  context,
                  "PASSKEY_UNAVAILABLE",
                );
              }
              const outcome =
                await authenticationService.authenticationOptions({
                  adapter:
                    context.context.adapter,
                  context,
                  config:
                    environment.webauthn,
                  requestId: id,
                  networkSource: network,
                });
              if (outcome.kind === "error") {
                return errorResponse(
                  context,
                  outcome.code,
                );
              }
              return context.json(
                Object.freeze({
                  options:
                    outcome.options,
                }),
                { status: 200 },
              );
            } catch {
              return errorResponse(
                context,
                "PASSKEY_UNAVAILABLE",
              );
            }
          },
        ),
      deltaPasskeyAuthenticationVerify:
        createAuthEndpoint(
          DELTA_INTERNAL_PASSKEY_AUTHENTICATION_PATHS[1],
          { method: "POST" },
          async (rawContext) => {
            const context =
              rawContext as EnrollmentEndpointContext;
            const id = requestId(context);
            try {
              const body =
                parseAuthenticationVerifyBody(
                  context.body,
                );
              if (!body) {
                return errorResponse(
                  context,
                  "PASSKEY_REQUEST_REJECTED",
                );
              }
              const network =
                networkSource(context);
              if (!network) {
                return errorResponse(
                  context,
                  "PASSKEY_UNAVAILABLE",
                );
              }
              const outcome =
                await authenticationService.authenticationVerify({
                  adapter:
                    context.context.adapter,
                  context,
                  config:
                    environment.webauthn,
                  requestId: id,
                  networkSource: network,
                  response: body.response,
                });
              if (outcome.kind === "error") {
                return errorResponse(
                  context,
                  outcome.code,
                );
              }
              return context.json(
                Object.freeze({
                  status: true as const,
                }),
                { status: 200 },
              );
            } catch {
              return errorResponse(
                context,
                "PASSKEY_UNAVAILABLE",
              );
            }
          },
        ),
    },
  } satisfies BetterAuthPlugin;
}
