import { getCurrentAdapter, runWithTransaction } from "@better-auth/core/context";
import type { GenericEndpointContext } from "@better-auth/core";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import type {
  DBAdapter,
  DBTransactionAdapter,
  Session,
  User,
} from "better-auth";
import { setSessionCookie } from "better-auth/cookies";

import type { WebAuthnEnvironment } from "./config.js";
import {
  PasskeyCeremonyError,
  passkeyCeremonyServices,
  type VerifiedPasskeyAuthentication,
} from "./passkey-ceremony.js";
import {
  clearPasskeyLookupCookie,
  type PasskeyChallengeContext,
} from "./passkey-challenge.js";
import {
  passkeyCounterFromDatabase,
  passkeyCounterToDatabase,
} from "./passkey-counter.js";
import { insertPasskeySessionMarker } from "../storage/passkey-session-marker.js";

type PasskeyAuthenticationContext = GenericEndpointContext &
  PasskeyChallengeContext;

type PasskeyCounterRecord = Readonly<{
  id: string;
  userId: string;
  counter: unknown;
}>;

type TransactionSuccess = Readonly<{
  kind: "authenticated";
  session: Session & Record<string, unknown>;
  user: User;
}>;

type TransactionResult = TransactionSuccess | Readonly<{ kind: "rejected" }>;

export type PasskeyAuthenticationOutcome =
  | Readonly<{ status: "authenticated" }>
  | Readonly<{ status: "rejected" }>;

export type PasskeyAuthenticationFailureCode =
  | "AUTHENTICATION_STATE_FAILURE"
  | "POST_COMMIT_COOKIE_FAILURE";

export class PasskeyAuthenticationFailure extends Error {
  readonly code: PasskeyAuthenticationFailureCode;

  constructor(code: PasskeyAuthenticationFailureCode) {
    super("Passkey authentication could not be completed.");
    this.name = "PasskeyAuthenticationFailure";
    this.code = code;
  }
}

type PasskeyAuthenticationDependencies = Readonly<{
  runTransaction: typeof runWithTransaction;
  currentAdapter: typeof getCurrentAdapter;
  verifyAuthentication: typeof passkeyCeremonyServices.verifyAuthentication;
  insertProvenance: typeof insertPasskeySessionMarker;
  setAuthCookie: typeof setSessionCookie;
  clearLookupCookie: typeof clearPasskeyLookupCookie;
  now: () => Date;
  bindTestTransactionSelector?: (input: Readonly<{
    adapter: DBTransactionAdapter;
    context: PasskeyAuthenticationContext;
  }>) => Promise<void>;
}>;

const productionDependencies: PasskeyAuthenticationDependencies = {
  runTransaction: runWithTransaction,
  currentAdapter: getCurrentAdapter,
  verifyAuthentication: (input) =>
    passkeyCeremonyServices.verifyAuthentication(input),
  insertProvenance: insertPasskeySessionMarker,
  setAuthCookie: setSessionCookie,
  clearLookupCookie: clearPasskeyLookupCookie,
  now: () => new Date(),
};

function isCommittedCredentialRejection(error: unknown): boolean {
  return (
    error instanceof PasskeyCeremonyError &&
    (error.code === "AUTHENTICATION_REJECTED" ||
      error.code === "CHALLENGE_REJECTED")
  );
}

function validatedCounter(value: unknown): number {
  try {
    if (typeof value === "string") return passkeyCounterFromDatabase(value);
    if (typeof value === "number") {
      return passkeyCounterFromDatabase(passkeyCounterToDatabase(value));
    }
  } catch {
    // The caller maps this invariant failure to an infrastructure rollback.
  }
  throw new PasskeyAuthenticationFailure("AUTHENTICATION_STATE_FAILURE");
}

export function validatePasskeyCounterTransition(
  storedCounter: unknown,
  newCounter: unknown,
): Readonly<{ stored: number; next: number; requiresCas: boolean }> {
  const stored = validatedCounter(storedCounter);
  const next = validatedCounter(newCounter);
  const counterless = stored === 0 && next === 0;
  if (!counterless && next <= stored) {
    throw new PasskeyAuthenticationFailure("AUTHENTICATION_STATE_FAILURE");
  }
  return Object.freeze({ stored, next, requiresCas: next !== stored });
}

async function readAuthoritativeCredential(
  adapter: DBTransactionAdapter,
  verified: VerifiedPasskeyAuthentication,
): Promise<PasskeyCounterRecord> {
  const current = await adapter.findOne<PasskeyCounterRecord>({
    model: "passkey",
    where: [{ field: "id", value: verified.passkeyId }],
  });
  if (
    !current ||
    current.id !== verified.passkeyId ||
    current.userId !== verified.userId
  ) {
    throw new PasskeyAuthenticationFailure("AUTHENTICATION_STATE_FAILURE");
  }
  return current;
}

async function compareAndSetCounter(
  adapter: DBTransactionAdapter,
  passkeyId: string,
  stored: number,
  next: number,
): Promise<void> {
  const updated = await adapter.incrementOne<PasskeyCounterRecord>({
    model: "passkey",
    where: [
      { field: "id", value: passkeyId },
      { field: "counter", value: stored },
    ],
    increment: {},
    set: { counter: next },
  });
  if (
    !updated ||
    updated.id !== passkeyId ||
    validatedCounter(updated.counter) !== next
  ) {
    throw new PasskeyAuthenticationFailure("AUTHENTICATION_STATE_FAILURE");
  }
}

export function createPasskeyAuthenticationOrchestrator(
  overrides: Partial<PasskeyAuthenticationDependencies> = {},
) {
  const dependencies: PasskeyAuthenticationDependencies = {
    ...productionDependencies,
    ...overrides,
  };

  return async function authenticatePasskey(input: Readonly<{
    adapter: DBAdapter;
    context: PasskeyAuthenticationContext;
    config: WebAuthnEnvironment;
    response: AuthenticationResponseJSON;
    dontRemember?: boolean;
  }>): Promise<PasskeyAuthenticationOutcome> {
    let committed: TransactionResult;
    try {
      committed = await dependencies.runTransaction(input.adapter, async () => {
        const transactionAdapter = await dependencies.currentAdapter(
          input.adapter,
        );
        if (transactionAdapter === input.adapter) {
          throw new PasskeyAuthenticationFailure(
            "AUTHENTICATION_STATE_FAILURE",
          );
        }

        await dependencies.bindTestTransactionSelector?.({
          adapter: transactionAdapter,
          context: input.context,
        });

        let verified: VerifiedPasskeyAuthentication;
        try {
          // The I5 service atomically consumes the I4 challenge first. Its
          // internal adapter call resolves to transactionAdapter here.
          verified = await dependencies.verifyAuthentication({
            adapter: transactionAdapter,
            challengeContext: input.context,
            config: input.config,
            response: input.response,
          });
        } catch (error) {
          if (isCommittedCredentialRejection(error)) {
            return Object.freeze({ kind: "rejected" as const });
          }
          throw error;
        }

        const credential = await readAuthoritativeCredential(
          transactionAdapter,
          verified,
        );
        const transition = validatePasskeyCounterTransition(
          credential.counter,
          verified.newCounter,
        );
        if (transition.requiresCas) {
          await compareAndSetCounter(
            transactionAdapter,
            credential.id,
            transition.stored,
            transition.next,
          );
        }

        const user = await transactionAdapter.findOne<User>({
          model: "user",
          where: [{ field: "id", value: verified.userId }],
        });
        if (!user || user.id !== verified.userId) {
          throw new PasskeyAuthenticationFailure(
            "AUTHENTICATION_STATE_FAILURE",
          );
        }

        const session = await input.context.context.internalAdapter.createSession(
          verified.userId,
          input.dontRemember,
        );
        if (!session) {
          throw new PasskeyAuthenticationFailure(
            "AUTHENTICATION_STATE_FAILURE",
          );
        }

        const authenticatedAt = dependencies.now();
        if (!Number.isFinite(authenticatedAt.getTime())) {
          throw new PasskeyAuthenticationFailure(
            "AUTHENTICATION_STATE_FAILURE",
          );
        }
        await dependencies.insertProvenance(transactionAdapter, {
          sessionId: session.id,
          passkeyId: verified.passkeyId,
          userVerified: true,
          credentialDeviceType: verified.credentialDeviceType,
          credentialBackedUp: verified.credentialBackedUp,
          authenticatedAt,
          aaguid: verified.aaguid,
          transports: verified.transports,
        });

        return Object.freeze({
          kind: "authenticated" as const,
          session,
          user,
        });
      });
    } catch (error) {
      if (error instanceof PasskeyAuthenticationFailure) throw error;
      throw new PasskeyAuthenticationFailure("AUTHENTICATION_STATE_FAILURE");
    }

    if (committed.kind === "rejected") {
      dependencies.clearLookupCookie(input.context);
      return Object.freeze({ status: "rejected" });
    }

    try {
      // runTransaction resolves only after COMMIT; no auth cookie exists sooner.
      await dependencies.setAuthCookie(input.context, {
        session: committed.session,
        user: committed.user,
      });
    } catch {
      throw new PasskeyAuthenticationFailure("POST_COMMIT_COOKIE_FAILURE");
    }
    dependencies.clearLookupCookie(input.context);
    return Object.freeze({ status: "authenticated" });
  };
}

export const authenticatePasskey = createPasskeyAuthenticationOrchestrator();

export const PASSKEY_SENSITIVE_RESPONSE_POLICY = Object.freeze({
  cacheControl: "no-store" as const,
  pragma: "no-cache" as const,
});

export type PasskeySecurityOperation =
  | "registrationOptions"
  | "registrationVerify"
  | "authenticationOptions"
  | "authenticationVerify"
  | "managementFreshProof"
  | "managementList"
  | "managementRename"
  | "managementDelete";

export type PasskeySecurityIdentity = Readonly<{
  kind: "network" | "user";
  source: string;
}>;

export type PasskeySafeErrorCode =
  | "PASSKEY_REQUEST_REJECTED"
  | "PASSKEY_RATE_LIMITED"
  | "PASSKEY_FRESH_PROOF_REJECTED"
  | "PASSKEY_CREDENTIAL_CONFLICT"
  | "PASSKEY_NOT_FOUND"
  | "PASSKEY_LAST_LOGIN_METHOD_REQUIRED"
  | "PASSKEY_UNAVAILABLE";

type PasskeyAuditReason =
  | "credential_rejected"
  | "rate_limited"
  | "fresh_proof_rejected"
  | "duplicate_credential"
  | "internal_failure";

type PasskeyAuditAction =
  | "passkey_registration"
  | "passkey_authentication"
  | "passkey_management_fresh_proof"
  | "passkey_management_list"
  | "passkey_management_rename"
  | "passkey_management_delete"
  | "passkey_rate_limit"
  | "passkey_security_failure";

type PasskeyAuditFacts = Readonly<{
  userVerified?: boolean;
  credentialDeviceType?: "singleDevice" | "multiDevice";
  credentialBackedUp?: boolean;
}>;

type PasskeySecurityAuditInput = Readonly<{
  requestId: string;
  action: PasskeyAuditAction;
  outcome:
    | "success"
    | "rejected"
    | "rate_limited"
    | "conflict"
    | "internal_failure";
  metadata: Readonly<{
    reason?: PasskeyAuditReason;
    userVerified?: boolean;
    credentialDeviceType?: "singleDevice" | "multiDevice";
    credentialBackedUp?: boolean;
  }>;
}>;

type PasskeySecurityDependencies = Readonly<{
  takeDurableLimit: (input: Readonly<{
    operation: PasskeySecurityOperation;
    identity: PasskeySecurityIdentity;
  }>) => Promise<boolean>;
  emitAudit: (event: PasskeySecurityAuditInput) => void;
  authenticate?: typeof authenticatePasskey;
}>;

export type PasskeySecurityResult<T> =
  | Readonly<{
      status: "success";
      value: T;
      cachePolicy: typeof PASSKEY_SENSITIVE_RESPONSE_POLICY;
    }>
  | Readonly<{
      status:
        | "rejected"
        | "rate_limited"
        | "conflict"
        | "not_found"
        | "last_login_method_required"
        | "unavailable";
      error: Readonly<{
        code: PasskeySafeErrorCode;
        message: "Passkey request could not be completed.";
      }>;
      cachePolicy: typeof PASSKEY_SENSITIVE_RESPONSE_POLICY;
    }>;

const PASSKEY_OPERATIONS = new Set<PasskeySecurityOperation>([
  "registrationOptions",
  "registrationVerify",
  "authenticationOptions",
  "authenticationVerify",
  "managementFreshProof",
  "managementList",
  "managementRename",
  "managementDelete",
]);

function safeError(
  status:
    | "rejected"
    | "rate_limited"
    | "conflict"
    | "not_found"
    | "last_login_method_required"
    | "unavailable",
  code: PasskeySafeErrorCode,
): PasskeySecurityResult<never> {
  return Object.freeze({
    status,
    error: Object.freeze({
      code,
      message: "Passkey request could not be completed." as const,
    }),
    cachePolicy: PASSKEY_SENSITIVE_RESPONSE_POLICY,
  });
}

function auditAction(operation: PasskeySecurityOperation): PasskeyAuditAction {
  if (operation === "managementFreshProof") {
    return "passkey_management_fresh_proof";
  }
  if (
    operation === "registrationOptions" ||
    operation === "registrationVerify"
  ) {
    return "passkey_registration";
  }
  if (operation === "managementList") {
    return "passkey_management_list";
  }
  if (operation === "managementRename") {
    return "passkey_management_rename";
  }
  if (operation === "managementDelete") {
    return "passkey_management_delete";
  }
  return "passkey_authentication";
}

export type PasskeySecurityValueClassification =
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

function safeAuditFacts(input: PasskeyAuditFacts | undefined) {
  const output: {
    userVerified?: boolean;
    credentialDeviceType?: "singleDevice" | "multiDevice";
    credentialBackedUp?: boolean;
  } = {};
  if (typeof input?.userVerified === "boolean") {
    output.userVerified = input.userVerified;
  }
  if (
    input?.credentialDeviceType === "singleDevice" ||
    input?.credentialDeviceType === "multiDevice"
  ) {
    output.credentialDeviceType = input.credentialDeviceType;
  }
  if (typeof input?.credentialBackedUp === "boolean") {
    output.credentialBackedUp = input.credentialBackedUp;
  }
  return Object.freeze(output);
}

function validWrapperInput(
  operation: PasskeySecurityOperation,
  requestId: string,
  identities: readonly PasskeySecurityIdentity[],
): boolean {
  if (
    !PASSKEY_OPERATIONS.has(operation) ||
    typeof requestId !== "string" ||
    requestId === "" ||
    requestId !== requestId.trim() ||
    requestId.length > 128 ||
    identities.length < 1 ||
    identities.length > 2
  ) {
    return false;
  }
  const seen = new Set<string>();
  for (const identity of identities) {
    if (
      (identity.kind !== "network" && identity.kind !== "user") ||
      typeof identity.source !== "string" ||
      identity.source === "" ||
      identity.source !== identity.source.trim() ||
      identity.source.length > 256
    ) {
      return false;
    }
    const identityClass = `${identity.kind}:${identity.source}`;
    if (seen.has(identityClass)) return false;
    seen.add(identityClass);
  }
  return true;
}

export function createPasskeySecurityPerimeter(
  dependencies: PasskeySecurityDependencies,
) {
  const authenticateCore = dependencies.authenticate ?? authenticatePasskey;

  function emitAudit(event: PasskeySecurityAuditInput): void {
    try {
      dependencies.emitAudit(event);
    } catch {
      // Audit delivery is best-effort and cannot alter authentication state.
    }
  }

  async function execute<T>(input: Readonly<{
    operation: PasskeySecurityOperation;
    requestId: string;
    identities: readonly PasskeySecurityIdentity[];
    run: () => Promise<T | null>;
    classify?: (value: T) => PasskeySecurityValueClassification;
    auditFacts?: PasskeyAuditFacts;
  }>): Promise<PasskeySecurityResult<T>> {
    if (!validWrapperInput(input.operation, input.requestId, input.identities)) {
      return safeError("rejected", "PASSKEY_REQUEST_REJECTED");
    }

    for (const identity of input.identities) {
      let allowed: boolean;
      try {
        allowed = await dependencies.takeDurableLimit({
          operation: input.operation,
          identity,
        });
      } catch {
        emitAudit({
          requestId: input.requestId,
          action: "passkey_security_failure",
          outcome: "internal_failure",
          metadata: Object.freeze({ reason: "internal_failure" }),
        });
        return safeError("unavailable", "PASSKEY_UNAVAILABLE");
      }
      if (!allowed) {
        emitAudit({
          requestId: input.requestId,
          action: "passkey_rate_limit",
          outcome: "rate_limited",
          metadata: Object.freeze({ reason: "rate_limited" }),
        });
        return safeError("rate_limited", "PASSKEY_RATE_LIMITED");
      }
    }

    let value: T | null;
    try {
      value = await input.run();
    } catch (error) {
      if (
        error instanceof PasskeyCeremonyError &&
        error.code === "CREDENTIAL_CONFLICT"
      ) {
        emitAudit({
          requestId: input.requestId,
          action: auditAction(input.operation),
          outcome: "conflict",
          metadata: Object.freeze({ reason: "duplicate_credential" }),
        });
        return safeError("conflict", "PASSKEY_CREDENTIAL_CONFLICT");
      }
      if (
        error instanceof PasskeyCeremonyError &&
        error.code !== "SERVICE_UNAVAILABLE"
      ) {
        const reason =
          input.operation === "managementFreshProof"
            ? "fresh_proof_rejected"
            : "credential_rejected";
        emitAudit({
          requestId: input.requestId,
          action: auditAction(input.operation),
          outcome: "rejected",
          metadata: Object.freeze({ reason }),
        });
        return safeError(
          "rejected",
          input.operation === "managementFreshProof"
            ? "PASSKEY_FRESH_PROOF_REJECTED"
            : "PASSKEY_REQUEST_REJECTED",
        );
      }
      emitAudit({
        requestId: input.requestId,
        action: "passkey_security_failure",
        outcome: "internal_failure",
        metadata: Object.freeze({ reason: "internal_failure" }),
      });
      return safeError("unavailable", "PASSKEY_UNAVAILABLE");
    }

    const classification =
      input.classify?.(value as T);
    if (
      classification &&
      classification.status !== "success"
    ) {
      emitAudit({
        requestId: input.requestId,
        action:
          classification.status === "unavailable"
            ? "passkey_security_failure"
            : auditAction(input.operation),
        outcome: classification.outcome,
        metadata: Object.freeze({
          ...(classification.status === "unavailable"
            ? { reason: "internal_failure" as const }
            : {}),
        }),
      });
      return safeError(
        classification.status,
        classification.code,
      );
    }

    if (
      value === null ||
      (typeof value === "object" &&
        value !== null &&
        "status" in value &&
        value.status === "rejected")
    ) {
      const reason =
        input.operation === "managementFreshProof"
          ? "fresh_proof_rejected"
          : "credential_rejected";
      emitAudit({
        requestId: input.requestId,
        action: auditAction(input.operation),
        outcome: "rejected",
        metadata: Object.freeze({ reason }),
      });
      return safeError(
        "rejected",
        input.operation === "managementFreshProof"
          ? "PASSKEY_FRESH_PROOF_REJECTED"
          : "PASSKEY_REQUEST_REJECTED",
      );
    }

    emitAudit({
      requestId: input.requestId,
      action: auditAction(input.operation),
      outcome: "success",
      metadata: safeAuditFacts(input.auditFacts),
    });
    return Object.freeze({
      status: "success" as const,
      value,
      cachePolicy: PASSKEY_SENSITIVE_RESPONSE_POLICY,
    });
  }

  async function authenticate(input: Readonly<{
    requestId: string;
    identities: readonly PasskeySecurityIdentity[];
    authentication: Parameters<typeof authenticatePasskey>[0];
  }>): Promise<PasskeySecurityResult<PasskeyAuthenticationOutcome>> {
    return execute({
      operation: "authenticationVerify",
      requestId: input.requestId,
      identities: input.identities,
      run: () => authenticateCore(input.authentication),
    });
  }

  return Object.freeze({ execute, authenticate });
}
