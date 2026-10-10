import type {
  IncomingHttpHeaders,
} from "node:http";

import {
  Router,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import {
  fromNodeHeaders,
} from "better-auth/node";

import {
  AUTH_PASSWORD_MAX_LENGTH,
} from "../auth/password-policy.js";
import {
  PASSKEY_PUBLIC_PREFIX,
  PASSKEY_PUBLIC_GENERIC_MESSAGE,
  PasskeyPublicError,
  createPasskeyPublicErrorEnvelope,
  passkeyErrorHandler,
  passkeySensitiveHeaders,
  passkeyStatusForCode,
  type PasskeySafePublicErrorCode,
} from "../middleware/passkey-errors.js";
import {
  getRequestId,
} from "../middleware/request-context.js";
import {
  getCurrentSessionContext,
} from "../middleware/require-session.js";
import type {
  CurrentSessionContext,
} from "../auth/session-context.js";

export {
  PASSKEY_JSON_BODY_LIMIT,
  PASSKEY_PUBLIC_PREFIX,
} from "../middleware/passkey-errors.js";

export const PASSKEY_PUBLIC_ROUTE_COUNT =
  7 as const;

export const PASSKEY_ROUTE_POLICIES =
  Object.freeze([
    Object.freeze({
      operation:
        "registrationOptions" as const,
      method: "POST" as const,
      path:
        `${PASSKEY_PUBLIC_PREFIX}/registration/options` as const,
      routerPath:
        "/registration/options" as const,
      authentication:
        "required" as const,
      trustedOrigin: true,
      freshProof: true,
      rateOperations:
        Object.freeze([
          "registrationOptions",
          "managementFreshProof",
        ] as const),
    }),
    Object.freeze({
      operation:
        "registrationVerify" as const,
      method: "POST" as const,
      path:
        `${PASSKEY_PUBLIC_PREFIX}/registration/verify` as const,
      routerPath:
        "/registration/verify" as const,
      authentication:
        "requiredSameSessionUser" as const,
      trustedOrigin: true,
      freshProof: false,
      rateOperations:
        Object.freeze([
          "registrationVerify",
        ] as const),
    }),
    Object.freeze({
      operation:
        "authenticationOptions" as const,
      method: "POST" as const,
      path:
        `${PASSKEY_PUBLIC_PREFIX}/authentication/options` as const,
      routerPath:
        "/authentication/options" as const,
      authentication:
        "notRequired" as const,
      trustedOrigin: true,
      freshProof: false,
      rateOperations:
        Object.freeze([
          "authenticationOptions",
        ] as const),
      rateIdentity:
        "networkOnly" as const,
    }),
    Object.freeze({
      operation:
        "authenticationVerify" as const,
      method: "POST" as const,
      path:
        `${PASSKEY_PUBLIC_PREFIX}/authentication/verify` as const,
      routerPath:
        "/authentication/verify" as const,
      authentication:
        "notRequired" as const,
      trustedOrigin: true,
      freshProof: false,
      rateOperations:
        Object.freeze([
          "authenticationVerify",
        ] as const),
      rateIdentity:
        "networkOnly" as const,
    }),
    Object.freeze({
      operation: "list" as const,
      method: "GET" as const,
      path:
        PASSKEY_PUBLIC_PREFIX,
      routerPath: "/" as const,
      authentication:
        "required" as const,
      trustedOrigin: false,
      freshProof: false,
      rateOperations:
        Object.freeze([
          "managementList",
        ] as const),
      rateIdentity: "user" as const,
      rateLimit: 60,
      rateWindowSeconds: 60,
    }),
    Object.freeze({
      operation: "rename" as const,
      method: "POST" as const,
      path:
        `${PASSKEY_PUBLIC_PREFIX}/:id/rename` as const,
      routerPath: "/:id/rename" as const,
      authentication:
        "required" as const,
      trustedOrigin: true,
      freshProof: false,
      rateOperations:
        Object.freeze([
          "managementRename",
        ] as const),
      rateIdentity: "user" as const,
      rateLimit: 5,
      rateWindowSeconds: 900,
    }),
    Object.freeze({
      operation: "delete" as const,
      method: "POST" as const,
      path:
        `${PASSKEY_PUBLIC_PREFIX}/:id/delete` as const,
      routerPath: "/:id/delete" as const,
      authentication:
        "required" as const,
      trustedOrigin: true,
      freshProof: true,
      rateOperations:
        Object.freeze([
          "managementFreshProof",
          "managementDelete",
        ] as const),
      rateIdentity: "user" as const,
      rateLimit: 5,
      rateWindowSeconds: 900,
    }),
  ]);

export type PasskeyRouteOperation =
  (typeof PASSKEY_ROUTE_POLICIES)[number]["operation"];

type UnknownRecord =
  Record<string, unknown>;

function isRecord(
  value: unknown,
): value is UnknownRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function rejectRequest(): never {
  throw new PasskeyPublicError(
    "PASSKEY_REQUEST_REJECTED",
  );
}

function exactKeys(
  value: UnknownRecord,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys =
    Object.keys(value);
  const allowed =
    new Set([
      ...required,
      ...optional,
    ]);
  return (
    required.every((key) =>
      keys.includes(key),
    ) &&
    keys.every((key) =>
      allowed.has(key),
    ) &&
    keys.length >= required.length &&
    keys.length <=
      required.length + optional.length
  );
}

function validPassword(
  value: unknown,
): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <=
      AUTH_PASSWORD_MAX_LENGTH
  );
}

function validTotpCode(
  value: unknown,
): value is string {
  return (
    typeof value === "string" &&
    /^[0-9]{6}$/.test(value)
  );
}

const PASSKEY_NAME_MAX_LENGTH = 64;
const PASSKEY_ID_MAX_LENGTH = 256;
const CONTROL_CHARACTERS =
  /[\u0000-\u001f\u007f-\u009f]/;

function validName(
  value: unknown,
): value is string {
  return (
    typeof value === "string" &&
    value !== "" &&
    value === value.trim() &&
    value.length <=
      PASSKEY_NAME_MAX_LENGTH &&
    !CONTROL_CHARACTERS.test(value)
  );
}

function validPasskeyId(
  value: unknown,
): value is string {
  return (
    typeof value === "string" &&
    value !== "" &&
    value === value.trim() &&
    value.length <=
      PASSKEY_ID_MAX_LENGTH &&
    !CONTROL_CHARACTERS.test(value)
  );
}

export function parsePasskeyId(
  value: unknown,
): string {
  if (!validPasskeyId(value)) {
    return rejectRequest();
  }
  return value;
}

function validPublicPasskeyId(
  value: unknown,
): value is string {
  return validPasskeyId(value);
}

/*
 * Public request rejection and malformed internal
 * state deliberately use different classifications.
 */
function requirePublicPasskeyId(
  value: unknown,
): string {
  if (
    !validPublicPasskeyId(value)
  ) {
    throw new PasskeyPublicError(
      "PASSKEY_UNAVAILABLE",
    );
  }
  return value;
}

export type PasskeyFreshProofBody =
  Readonly<{
    password: string;
    totpCode?: string;
  }>;

function parseFreshProofBody(
  value: unknown,
): PasskeyFreshProofBody {
  if (
    !isRecord(value) ||
    !exactKeys(
      value,
      ["password"],
      ["totpCode"],
    ) ||
    !validPassword(value.password) ||
    (
      value.totpCode !== undefined &&
      !validTotpCode(value.totpCode)
    )
  ) {
    return rejectRequest();
  }
  return Object.freeze({
    password: value.password,
    ...(value.totpCode === undefined
      ? {}
      : { totpCode: value.totpCode }),
  });
}

export function parseRegistrationOptionsBody(
  value: unknown,
): PasskeyFreshProofBody {
  return parseFreshProofBody(value);
}

export type PasskeyRegistrationVerifyBody =
  Readonly<{
    response:
      Readonly<Record<string, unknown>>;
    name?: string;
  }>;

export function parseRegistrationVerifyBody(
  value: unknown,
): PasskeyRegistrationVerifyBody {
  if (
    !isRecord(value) ||
    !exactKeys(
      value,
      ["response"],
      ["name"],
    ) ||
    !isRecord(value.response) ||
    (
      value.name !== undefined &&
      !validName(value.name)
    )
  ) {
    return rejectRequest();
  }
  return Object.freeze({
    response: value.response,
    ...(value.name === undefined
      ? {}
      : { name: value.name }),
  });
}

export function parseAuthenticationOptionsBody(
  value: unknown,
): Readonly<Record<string, never>> {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 0
  ) {
    return rejectRequest();
  }
  return Object.freeze({});
}

export type PasskeyAuthenticationVerifyBody =
  Readonly<{
    response:
      Readonly<Record<string, unknown>>;
  }>;

export function parseAuthenticationVerifyBody(
  value: unknown,
): PasskeyAuthenticationVerifyBody {
  if (
    !isRecord(value) ||
    !exactKeys(
      value,
      ["response"],
    ) ||
    !isRecord(value.response)
  ) {
    return rejectRequest();
  }
  return Object.freeze({
    response: value.response,
  });
}

export function parsePasskeyListBody(
  value: unknown,
): undefined {
  if (value !== undefined) {
    return rejectRequest();
  }
  return undefined;
}

export type PasskeyRenameBody =
  Readonly<{ name: string }>;

export function parsePasskeyRenameBody(
  value: unknown,
): PasskeyRenameBody {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["name"]) ||
    !validName(value.name)
  ) {
    return rejectRequest();
  }
  return Object.freeze({
    name: value.name,
  });
}

export function parsePasskeyDeleteBody(
  value: unknown,
): PasskeyFreshProofBody {
  return parseFreshProofBody(value);
}

export type PublicEnrollmentPasskey =
  Readonly<{
    id: string;
    name: string | null;
    deviceType:
      "singleDevice" | "multiDevice";
    backedUp: boolean;
  }>;

export type PublicManagedPasskey =
  PublicEnrollmentPasskey &
  Readonly<{ createdAt: string }>;

function publicPasskeyBase(
  value: unknown,
): PublicEnrollmentPasskey {
  if (!isRecord(value)) {
    throw new PasskeyPublicError(
      "PASSKEY_UNAVAILABLE",
    );
  }
  const name = value.name;
  if (
    requirePublicPasskeyId(value.id) !== value.id ||
    (
      name !== null &&
      !validName(name)
    ) ||
    (
      value.deviceType !==
        "singleDevice" &&
      value.deviceType !==
        "multiDevice"
    ) ||
    typeof value.backedUp !== "boolean"
  ) {
    throw new PasskeyPublicError(
      "PASSKEY_UNAVAILABLE",
    );
  }
  return Object.freeze({
    id: value.id,
    name,
    deviceType: value.deviceType,
    backedUp: value.backedUp,
  });
}

export function projectEnrollmentPasskey(
  value: unknown,
): PublicEnrollmentPasskey {
  return publicPasskeyBase(value);
}

function projectCreatedAt(
  value: unknown,
): string {
  const date =
    value instanceof Date
      ? value
      : typeof value === "string"
        ? new Date(value)
        : null;
  if (
    date === null ||
    !Number.isFinite(
      date.getTime(),
    )
  ) {
    throw new PasskeyPublicError(
      "PASSKEY_UNAVAILABLE",
    );
  }
  const output = date.toISOString();
  if (
    typeof value === "string" &&
    value !== output
  ) {
    throw new PasskeyPublicError(
      "PASSKEY_UNAVAILABLE",
    );
  }
  return output;
}

export function projectManagedPasskey(
  value: unknown,
): PublicManagedPasskey {
  const base =
    publicPasskeyBase(value);
  const record =
    value as UnknownRecord;
  return Object.freeze({
    ...base,
    createdAt:
      projectCreatedAt(
        record.createdAt,
      ),
  });
}

export function projectPasskeyList(
  value: unknown,
): readonly PublicManagedPasskey[] {
  if (!Array.isArray(value)) {
    throw new PasskeyPublicError(
      "PASSKEY_UNAVAILABLE",
    );
  }
  return Object.freeze(
    value.map((item) =>
      projectManagedPasskey(item),
    ),
  );
}

function projectOptions(
  value: unknown,
): Readonly<{
  options: Readonly<Record<string, unknown>>;
}> {
  if (!isRecord(value)) {
    throw new PasskeyPublicError(
      "PASSKEY_UNAVAILABLE",
    );
  }
  return Object.freeze({
    options: value,
  });
}

export function projectAuthenticationSuccess(
  value: unknown,
): Readonly<{ status: true }> {
  if (
    !isRecord(value) ||
    value.status !== true
  ) {
    throw new PasskeyPublicError(
      "PASSKEY_UNAVAILABLE",
    );
  }
  return Object.freeze({
    status: true as const,
  });
}

export const PASSKEY_COOKIE_ALLOWLIST_CLASSES =
  Object.freeze([
    "PASSKEY_LOOKUP_COOKIE",
    "BETTER_AUTH_AUTH_SESSION_COOKIE",
    "BETTER_AUTH_SESSION_REFRESH_OR_STALE_CLEAR_COOKIE",
  ] as const);

export const PASSKEY_COOKIE_ALLOWED_NAMES =
  Object.freeze([
    "delta-auth.delta_passkey_challenge",
    "__Secure-delta-auth.delta_passkey_challenge",
    "delta-auth.session_token",
    "__Secure-delta-auth.session_token",
  ] as const);

export type PasskeyCookieClass =
  "lookup" | "authSession";
export type PasskeyCookieAction =
  "set" | "clear";
export type PasskeyCookieRequirement =
  Readonly<{
    cookieClass: PasskeyCookieClass;
    action: PasskeyCookieAction;
  }>;

type ParsedCookie = Readonly<{
  cookieClass: PasskeyCookieClass;
  action: PasskeyCookieAction;
}>;

function invalidInternalResult(): never {
  throw new PasskeyPublicError(
    "PASSKEY_UNAVAILABLE",
  );
}

function parseCookieInteger(
  value: string | true,
): number {
  if (
    typeof value !== "string" ||
    !/^-?[0-9]+$/.test(value)
  ) {
    return invalidInternalResult();
  }
  const result = Number(value);
  if (!Number.isSafeInteger(result)) {
    return invalidInternalResult();
  }
  return result;
}

function parsePasskeySetCookie(
  raw: string,
  secureCookies: boolean,
): ParsedCookie {
  if (
    typeof raw !== "string" ||
    raw === "" ||
    raw.length > 8192 ||
    /[\r\n]/.test(raw)
  ) {
    return invalidInternalResult();
  }

  /*
   * Each input is one framework-provided
   * Headers.getSetCookie() entry. Splitting only
   * on semicolons deliberately preserves commas
   * inside Expires.
   */
  const segments =
    raw.split(";").map((part) =>
      part.trim(),
    );
  const first = segments.shift();
  if (!first) {
    return invalidInternalResult();
  }
  const equals = first.indexOf("=");
  if (equals <= 0) {
    return invalidInternalResult();
  }
  const name = first.slice(0, equals);
  const value = first.slice(equals + 1);
  if (
    !PASSKEY_COOKIE_ALLOWED_NAMES.includes(
      name as
        (typeof PASSKEY_COOKIE_ALLOWED_NAMES)[number],
    ) ||
    /[\u0000-\u001f\u007f;]/.test(value)
  ) {
    return invalidInternalResult();
  }

  const attributes =
    new Map<string, string | true>();
  for (const segment of segments) {
    if (segment === "") {
      return invalidInternalResult();
    }
    const separator =
      segment.indexOf("=");
    const attributeName =
      (
        separator === -1
          ? segment
          : segment.slice(
              0,
              separator,
            )
      ).toLowerCase();
    const attributeValue =
      separator === -1
        ? true
        : segment.slice(
            separator + 1,
          );
    if (
      attributes.has(attributeName) ||
      ![
        "domain",
        "expires",
        "httponly",
        "max-age",
        "path",
        "samesite",
        "secure",
      ].includes(attributeName)
    ) {
      return invalidInternalResult();
    }
    attributes.set(
      attributeName,
      attributeValue,
    );
  }

  if (
    attributes.has("domain") ||
    attributes.get("httponly") !== true ||
    attributes.get("samesite") !== "Lax" &&
      attributes.get("samesite") !== "lax"
  ) {
    return invalidInternalResult();
  }

  const secureName =
    name.startsWith("__Secure-");
  const secureAttribute =
    attributes.get("secure") === true;
  if (
    secureName !== secureCookies ||
    secureAttribute !== secureCookies
  ) {
    return invalidInternalResult();
  }

  const cookieClass:
    PasskeyCookieClass =
    name.endsWith(
      ".delta_passkey_challenge",
    )
      ? "lookup"
      : "authSession";
  const expectedPath =
    cookieClass === "lookup"
      ? "/api"
      : "/";
  if (
    attributes.get("path") !==
    expectedPath
  ) {
    return invalidInternalResult();
  }

  if (attributes.has("expires")) {
    const expires =
      attributes.get("expires");
    if (
      typeof expires !== "string" ||
      !Number.isFinite(
        new Date(expires).getTime(),
      )
    ) {
      return invalidInternalResult();
    }
  }

  const maxAge =
    attributes.has("max-age")
      ? parseCookieInteger(
          attributes.get("max-age")!,
        )
      : undefined;
  const action:
    PasskeyCookieAction =
    value === "" && maxAge === 0
      ? "clear"
      : value !== "" && maxAge !== 0
        ? "set"
        : invalidInternalResult();

  if (
    cookieClass === "lookup" &&
    action === "set" &&
    maxAge !== 300
  ) {
    return invalidInternalResult();
  }
  if (
    cookieClass === "authSession" &&
    action === "set" &&
    maxAge !== undefined &&
    maxAge <= 0
  ) {
    return invalidInternalResult();
  }

  return Object.freeze({
    cookieClass,
    action,
  });
}

export function validatePasskeySetCookies(
  cookies: readonly string[],
  requirements:
    readonly PasskeyCookieRequirement[],
  secureCookies: boolean,
): readonly string[] {
  if (
    !Array.isArray(cookies) ||
    !Array.isArray(requirements) ||
    typeof secureCookies !== "boolean" ||
    cookies.length !==
      requirements.length
  ) {
    return invalidInternalResult();
  }

  const remaining =
    requirements.map((requirement) =>
      `${requirement.cookieClass}:${requirement.action}`,
    );
  for (const raw of cookies) {
    const parsed =
      parsePasskeySetCookie(
        raw,
        secureCookies,
      );
    const key =
      `${parsed.cookieClass}:${parsed.action}`;
    const index = remaining.indexOf(key);
    if (index === -1) {
      return invalidInternalResult();
    }
    remaining.splice(index, 1);
  }
  if (remaining.length !== 0) {
    return invalidInternalResult();
  }
  return Object.freeze([...cookies]);
}

export type PasskeyOperationResult =
  | Readonly<{
      kind: "success";
      value: unknown;
      setCookies: readonly string[];
    }>
  | Readonly<{
      kind: "error";
      code: PasskeySafePublicErrorCode;
      setCookies: readonly string[];
    }>;

const SAFE_CODES =
  new Set<PasskeySafePublicErrorCode>([
    "PASSKEY_REQUEST_REJECTED",
    "PASSKEY_RATE_LIMITED",
    "PASSKEY_FRESH_PROOF_REJECTED",
    "PASSKEY_CREDENTIAL_CONFLICT",
    "PASSKEY_UNAVAILABLE",
    "PASSKEY_NOT_FOUND",
    "PASSKEY_LAST_LOGIN_METHOD_REQUIRED",
  ]);

const ALLOWED_ERROR_CODES:
  Readonly<Record<
    PasskeyRouteOperation,
    ReadonlySet<
      PasskeySafePublicErrorCode
    >
  >> = Object.freeze({
    registrationOptions: new Set<PasskeySafePublicErrorCode>([
      "PASSKEY_REQUEST_REJECTED",
      "PASSKEY_RATE_LIMITED",
      "PASSKEY_FRESH_PROOF_REJECTED",
      "PASSKEY_UNAVAILABLE",
    ]),
    registrationVerify: new Set<PasskeySafePublicErrorCode>([
      "PASSKEY_REQUEST_REJECTED",
      "PASSKEY_RATE_LIMITED",
      "PASSKEY_CREDENTIAL_CONFLICT",
      "PASSKEY_UNAVAILABLE",
    ]),
    authenticationOptions: new Set<PasskeySafePublicErrorCode>([
      "PASSKEY_REQUEST_REJECTED",
      "PASSKEY_RATE_LIMITED",
      "PASSKEY_UNAVAILABLE",
    ]),
    authenticationVerify: new Set<PasskeySafePublicErrorCode>([
      "PASSKEY_REQUEST_REJECTED",
      "PASSKEY_RATE_LIMITED",
      "PASSKEY_UNAVAILABLE",
    ]),
    list: new Set<PasskeySafePublicErrorCode>([
      "PASSKEY_REQUEST_REJECTED",
      "PASSKEY_RATE_LIMITED",
      "PASSKEY_UNAVAILABLE",
    ]),
    rename: new Set<PasskeySafePublicErrorCode>([
      "PASSKEY_REQUEST_REJECTED",
      "PASSKEY_RATE_LIMITED",
      "PASSKEY_NOT_FOUND",
      "PASSKEY_UNAVAILABLE",
    ]),
    delete: new Set<PasskeySafePublicErrorCode>([
      "PASSKEY_REQUEST_REJECTED",
      "PASSKEY_RATE_LIMITED",
      "PASSKEY_FRESH_PROOF_REJECTED",
      "PASSKEY_NOT_FOUND",
      "PASSKEY_LAST_LOGIN_METHOD_REQUIRED",
      "PASSKEY_UNAVAILABLE",
    ]),
  });

const SUCCESS_STATUS:
  Readonly<Record<
    PasskeyRouteOperation,
    number
  >> = Object.freeze({
    registrationOptions: 200,
    registrationVerify: 201,
    authenticationOptions: 200,
    authenticationVerify: 200,
    list: 200,
    rename: 200,
    delete: 204,
  });

function successBody(
  operation: PasskeyRouteOperation,
  value: unknown,
): unknown {
  switch (operation) {
    case "registrationOptions":
    case "authenticationOptions":
      return projectOptions(value);
    case "registrationVerify":
      return Object.freeze({
        passkey:
          projectEnrollmentPasskey(
            value,
          ),
      });
    case "authenticationVerify":
      return projectAuthenticationSuccess(
        value,
      );
    case "list":
      return Object.freeze({
        passkeys:
          projectPasskeyList(value),
      });
    case "rename":
      return Object.freeze({
        passkey:
          projectManagedPasskey(value),
      });
    case "delete":
      if (value !== undefined) {
        return invalidInternalResult();
      }
      return undefined;
  }
}

function expectedCookies(
  operation: PasskeyRouteOperation,
  result: PasskeyOperationResult,
): readonly PasskeyCookieRequirement[] {
  if (result.kind === "success") {
    switch (operation) {
      case "registrationOptions":
      case "authenticationOptions":
        return Object.freeze([
          Object.freeze({
            cookieClass:
              "lookup" as const,
            action: "set" as const,
          }),
        ]);
      case "registrationVerify":
        return Object.freeze([
          Object.freeze({
            cookieClass:
              "lookup" as const,
            action: "clear" as const,
          }),
        ]);
      case "authenticationVerify":
        return Object.freeze([
          Object.freeze({
            cookieClass:
              "authSession" as const,
            action: "set" as const,
          }),
          Object.freeze({
            cookieClass:
              "lookup" as const,
            action: "clear" as const,
          }),
        ]);
      case "list":
      case "rename":
      case "delete":
        return Object.freeze([]);
    }
  }

  if (
    result.code ===
      "PASSKEY_REQUEST_REJECTED" &&
    (
      operation ===
        "registrationVerify" ||
      operation ===
        "authenticationVerify"
    )
  ) {
    return Object.freeze([
      Object.freeze({
        cookieClass: "lookup" as const,
        action: "clear" as const,
      }),
    ]);
  }
  return Object.freeze([]);
}

const validatedResponse =
  Symbol("delta.passkey.validated-response");

export type ValidatedPasskeyPublicResponse =
  Readonly<{
    status: number;
    body: unknown;
    setCookies: readonly string[];
    [validatedResponse]: true;
  }>;

function validOperationResult(
  value: unknown,
): value is PasskeyOperationResult {
  if (!isRecord(value)) return false;
  if (
    value.kind === "success"
  ) {
    return (
      exactKeys(
        value,
        ["kind", "value", "setCookies"],
      ) &&
      Array.isArray(value.setCookies) &&
      value.setCookies.every(
        (cookie) =>
          typeof cookie === "string",
      )
    );
  }
  return (
    value.kind === "error" &&
    exactKeys(
      value,
      ["kind", "code", "setCookies"],
    ) &&
    typeof value.code === "string" &&
    SAFE_CODES.has(
      value.code as
        PasskeySafePublicErrorCode,
    ) &&
    Array.isArray(value.setCookies) &&
    value.setCookies.every(
      (cookie) =>
        typeof cookie === "string",
    )
  );
}

export function preparePasskeyPublicResponse(
  operation: PasskeyRouteOperation,
  result: unknown,
  secureCookies: boolean,
  requestId: string,
): ValidatedPasskeyPublicResponse {
  if (
    !validOperationResult(result) ||
    typeof secureCookies !== "boolean"
  ) {
    return invalidInternalResult();
  }

  let status: number;
  let body: unknown;

  /*
   * Body/classification validation intentionally
   * precedes cookie validation. No caller can get
   * a branded appendable result until both pass.
   */
  if (result.kind === "success") {
    status = SUCCESS_STATUS[operation];
    body = successBody(
      operation,
      result.value,
    );
  } else {
    if (
      !ALLOWED_ERROR_CODES[
        operation
      ].has(result.code)
    ) {
      return invalidInternalResult();
    }
    status =
      passkeyStatusForCode(
        result.code,
      );
    body =
      createPasskeyPublicErrorEnvelope(
        result.code,
        requestId,
      );
  }

  const setCookies =
    validatePasskeySetCookies(
      result.setCookies,
      expectedCookies(
        operation,
        result,
      ),
      secureCookies,
    );

  return Object.freeze({
    status,
    body,
    setCookies,
    [validatedResponse]: true as const,
  });
}

export function appendValidatedPasskeyCookies(
  response: Response,
  prepared:
    ValidatedPasskeyPublicResponse,
): void {
  if (
    prepared[validatedResponse] !== true
  ) {
    return invalidInternalResult();
  }
  for (const cookie of
    prepared.setCookies) {
    response.append(
      "Set-Cookie",
      cookie,
    );
  }
}

export type PasskeyRouteContext =
  Readonly<{
    headers:
      Readonly<IncomingHttpHeaders>;
    requestId: string;
    currentSession?: CurrentSessionContext;
  }>;

type PasskeyOperation<Input> =
  (
    input: Readonly<{
      context: PasskeyRouteContext;
      value: Input;
    }>,
  ) => Promise<PasskeyOperationResult>;

export type PasskeyRouteOperations =
  Readonly<{
    registrationOptions:
      PasskeyOperation<
        PasskeyFreshProofBody
      >;
    registrationVerify:
      PasskeyOperation<
        PasskeyRegistrationVerifyBody
      >;
    authenticationOptions:
      PasskeyOperation<
        Readonly<Record<string, never>>
      >;
    authenticationVerify:
      PasskeyOperation<
        PasskeyAuthenticationVerifyBody
      >;
    list:
      PasskeyOperation<undefined>;
    rename:
      PasskeyOperation<
        Readonly<{
          id: string;
          name: string;
        }>
      >;
    delete:
      PasskeyOperation<
        Readonly<{
          id: string;
          proof:
            PasskeyFreshProofBody;
        }>
      >;
  }>;

export type PasskeyRouterDependencies =
  Readonly<{
    operations: PasskeyRouteOperations;
    secureCookies: boolean;
    managementSecurity: Readonly<{
      requireSession: RequestHandler;
      requireTrustedOrigin: RequestHandler;
    }>;
  }>;

export type PasskeyEnrollmentAuthBridge =
  Readonly<{
    api: Readonly<{
      deltaPasskeyEnrollmentOptions:
        (input: Readonly<{
          headers: Headers;
          body: PasskeyFreshProofBody;
          asResponse: true;
        }>) => Promise<globalThis.Response>;
      deltaPasskeyEnrollmentVerify:
        (input: Readonly<{
          headers: Headers;
          body:
            PasskeyRegistrationVerifyBody;
          asResponse: true;
        }>) => Promise<globalThis.Response>;
    }>;
  }>;

export type PasskeyAuthenticationAuthBridge =
  Readonly<{
    api: Readonly<{
      deltaPasskeyAuthenticationOptions:
        (input: Readonly<{
          headers: Headers;
          body: Readonly<Record<string, never>>;
          asResponse: true;
        }>) => Promise<globalThis.Response>;
      deltaPasskeyAuthenticationVerify:
        (input: Readonly<{
          headers: Headers;
          body:
            PasskeyAuthenticationVerifyBody;
          asResponse: true;
        }>) => Promise<globalThis.Response>;
    }>;
  }>;

function internalSetCookies(
  headers: Headers,
): readonly string[] {
  const candidate =
    headers as Headers & {
      getSetCookie?: () => string[];
    };
  if (
    typeof candidate.getSetCookie !==
      "function"
  ) {
    throw new PasskeyPublicError(
      "PASSKEY_UNAVAILABLE",
    );
  }
  return Object.freeze([
    ...candidate.getSetCookie(),
  ]);
}

function safeInternalErrorCode(
  value: unknown,
): PasskeySafePublicErrorCode | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["error"]) ||
    !isRecord(value.error) ||
    !exactKeys(
      value.error,
      ["code", "message"],
    ) ||
    typeof value.error.code !==
      "string" ||
    !SAFE_CODES.has(
      value.error.code as
        PasskeySafePublicErrorCode,
    ) ||
    value.error.message !==
      PASSKEY_PUBLIC_GENERIC_MESSAGE
  ) {
    return null;
  }
  return value.error.code as
    PasskeySafePublicErrorCode;
}

function expectedInternalErrorStatus(
  code: PasskeySafePublicErrorCode,
  status: number,
): boolean {
  return (
    status ===
      passkeyStatusForCode(code) ||
    (
      code ===
        "PASSKEY_REQUEST_REJECTED" &&
      status === 401
    )
  );
}

async function classifyEnrollmentResponse(
  operation:
    | "registrationOptions"
    | "registrationVerify",
  response: globalThis.Response,
): Promise<PasskeyOperationResult> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return Object.freeze({
      kind: "error" as const,
      code:
        "PASSKEY_UNAVAILABLE" as const,
      setCookies: Object.freeze([]),
    });
  }

  const cookies =
    internalSetCookies(
      response.headers,
    );
  if (response.ok) {
    if (
      operation ===
        "registrationOptions" &&
      response.status === 200 &&
      isRecord(body) &&
      exactKeys(body, ["options"]) &&
      isRecord(body.options)
    ) {
      return Object.freeze({
        kind: "success" as const,
        value: body.options,
        setCookies: cookies,
      });
    }
    if (
      operation ===
        "registrationVerify" &&
      response.status === 201 &&
      isRecord(body) &&
      exactKeys(body, ["passkey"]) &&
      isRecord(body.passkey)
    ) {
      return Object.freeze({
        kind: "success" as const,
        value: body.passkey,
        setCookies: cookies,
      });
    }
    return Object.freeze({
      kind: "error" as const,
      code:
        "PASSKEY_UNAVAILABLE" as const,
      setCookies: Object.freeze([]),
    });
  }

  const code =
    safeInternalErrorCode(body);
  if (
    code === null ||
    !ALLOWED_ERROR_CODES[
      operation
    ].has(code) ||
    !expectedInternalErrorStatus(
      code,
      response.status,
    )
  ) {
    return Object.freeze({
      kind: "error" as const,
      code:
        "PASSKEY_UNAVAILABLE" as const,
      setCookies: Object.freeze([]),
    });
  }
  return Object.freeze({
    kind: "error" as const,
    code,
    setCookies: cookies,
  });
}

async function classifyAuthenticationResponse(
  operation:
    | "authenticationOptions"
    | "authenticationVerify",
  response: globalThis.Response,
): Promise<PasskeyOperationResult> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return Object.freeze({
      kind: "error" as const,
      code:
        "PASSKEY_UNAVAILABLE" as const,
      setCookies: Object.freeze([]),
    });
  }

  const cookies =
    internalSetCookies(
      response.headers,
    );
  if (response.ok) {
    if (
      operation ===
        "authenticationOptions" &&
      response.status === 200 &&
      isRecord(body) &&
      exactKeys(body, ["options"]) &&
      isRecord(body.options)
    ) {
      return Object.freeze({
        kind: "success" as const,
        value: body.options,
        setCookies: cookies,
      });
    }
    if (
      operation ===
        "authenticationVerify" &&
      response.status === 200 &&
      isRecord(body) &&
      exactKeys(body, ["status"]) &&
      body.status === true
    ) {
      return Object.freeze({
        kind: "success" as const,
        value: Object.freeze({
          status: true as const,
        }),
        setCookies: cookies,
      });
    }
    return Object.freeze({
      kind: "error" as const,
      code:
        "PASSKEY_UNAVAILABLE" as const,
      setCookies: Object.freeze([]),
    });
  }

  const code =
    safeInternalErrorCode(body);
  if (
    code === null ||
    !ALLOWED_ERROR_CODES[
      operation
    ].has(code) ||
    !expectedInternalErrorStatus(
      code,
      response.status,
    )
  ) {
    return Object.freeze({
      kind: "error" as const,
      code:
        "PASSKEY_UNAVAILABLE" as const,
      setCookies: Object.freeze([]),
    });
  }
  return Object.freeze({
    kind: "error" as const,
    code,
    setCookies: cookies,
  });
}

export function createPasskeyEnrollmentRouteOperations(
  auth: PasskeyEnrollmentAuthBridge,
): Pick<
  PasskeyRouteOperations,
  | "registrationOptions"
  | "registrationVerify"
> {
  if (
    typeof auth !== "object" ||
    auth === null ||
    typeof auth.api !== "object" ||
    auth.api === null ||
    typeof auth.api
      .deltaPasskeyEnrollmentOptions !==
      "function" ||
    typeof auth.api
      .deltaPasskeyEnrollmentVerify !==
      "function"
  ) {
    throw new Error(
      "Passkey enrollment bridge is incomplete.",
    );
  }

  async function invoke(
    operation:
      | "registrationOptions"
      | "registrationVerify",
    context: PasskeyRouteContext,
    value:
      | PasskeyFreshProofBody
      | PasskeyRegistrationVerifyBody,
  ): Promise<PasskeyOperationResult> {
    const headers =
      fromNodeHeaders(
        context.headers,
      );
    headers.set(
      "x-request-id",
      context.requestId,
    );
    let response:
      globalThis.Response;
    try {
      response =
        operation ===
          "registrationOptions"
          ? await auth.api
              .deltaPasskeyEnrollmentOptions({
                headers,
                body:
                  value as PasskeyFreshProofBody,
                asResponse: true,
              })
          : await auth.api
              .deltaPasskeyEnrollmentVerify({
                headers,
                body:
                  value as PasskeyRegistrationVerifyBody,
                asResponse: true,
              });
    } catch {
      return Object.freeze({
        kind: "error" as const,
        code:
          "PASSKEY_UNAVAILABLE" as const,
        setCookies: Object.freeze([]),
      });
    }
    try {
      return await classifyEnrollmentResponse(
        operation,
        response,
      );
    } catch {
      return Object.freeze({
        kind: "error" as const,
        code:
          "PASSKEY_UNAVAILABLE" as const,
        setCookies: Object.freeze([]),
      });
    }
  }

  return Object.freeze({
    registrationOptions: ({
      context,
      value,
    }) =>
      invoke(
        "registrationOptions",
        context,
        value,
      ),
    registrationVerify: ({
      context,
      value,
    }) =>
      invoke(
        "registrationVerify",
        context,
        value,
      ),
  });
}

export function createPasskeyAuthenticationRouteOperations(
  auth: PasskeyAuthenticationAuthBridge,
): Pick<
  PasskeyRouteOperations,
  | "authenticationOptions"
  | "authenticationVerify"
> {
  if (
    typeof auth !== "object" ||
    auth === null ||
    typeof auth.api !== "object" ||
    auth.api === null ||
    typeof auth.api
      .deltaPasskeyAuthenticationOptions !==
      "function" ||
    typeof auth.api
      .deltaPasskeyAuthenticationVerify !==
      "function"
  ) {
    throw new Error(
      "Passkey authentication bridge is incomplete.",
    );
  }

  async function invoke(
    operation:
      | "authenticationOptions"
      | "authenticationVerify",
    context: PasskeyRouteContext,
    value:
      | Readonly<Record<string, never>>
      | PasskeyAuthenticationVerifyBody,
  ): Promise<PasskeyOperationResult> {
    const headers =
      fromNodeHeaders(
        context.headers,
      );
    headers.set(
      "x-request-id",
      context.requestId,
    );
    let response:
      globalThis.Response;
    try {
      response =
        operation ===
          "authenticationOptions"
          ? await auth.api
              .deltaPasskeyAuthenticationOptions({
                headers,
                body:
                  value as Readonly<Record<string, never>>,
                asResponse: true,
              })
          : await auth.api
              .deltaPasskeyAuthenticationVerify({
                headers,
                body:
                  value as PasskeyAuthenticationVerifyBody,
                asResponse: true,
              });
    } catch {
      return Object.freeze({
        kind: "error" as const,
        code:
          "PASSKEY_UNAVAILABLE" as const,
        setCookies: Object.freeze([]),
      });
    }
    try {
      return await classifyAuthenticationResponse(
        operation,
        response,
      );
    } catch {
      return Object.freeze({
        kind: "error" as const,
        code:
          "PASSKEY_UNAVAILABLE" as const,
        setCookies: Object.freeze([]),
      });
    }
  }

  return Object.freeze({
    authenticationOptions: ({
      context,
      value,
    }) =>
      invoke(
        "authenticationOptions",
        context,
        value,
      ),
    authenticationVerify: ({
      context,
      value,
    }) =>
      invoke(
        "authenticationVerify",
        context,
        value,
      ),
  });
}

export type PasskeyManagementService = Readonly<{
  list: (input: Readonly<{
    session: CurrentSessionContext;
    requestId: string;
  }>) => Promise<Readonly<{
    kind: "success";
    value: unknown;
  }> | Readonly<{
    kind: "error";
    code: PasskeySafePublicErrorCode;
  }>>;
  rename: (input: Readonly<{
    session: CurrentSessionContext;
    requestId: string;
    id: string;
    name: string;
  }>) => Promise<Readonly<{
    kind: "success";
    value: unknown;
  }> | Readonly<{
    kind: "error";
    code: PasskeySafePublicErrorCode;
  }>>;
  remove: (input: Readonly<{
    session: CurrentSessionContext;
    requestId: string;
    networkSource: string;
    requestOrigin: string | undefined;
    id: string;
    proof: PasskeyFreshProofBody;
  }>) => Promise<Readonly<{
    kind: "success";
    value: undefined;
  }> | Readonly<{
    kind: "error";
    code: PasskeySafePublicErrorCode;
  }>>;
}>;

function managementSession(
  context: PasskeyRouteContext,
): CurrentSessionContext {
  if (!context.currentSession) {
    throw new PasskeyPublicError(
      "PASSKEY_UNAVAILABLE",
    );
  }
  return context.currentSession;
}

function singleHeader(
  headers: Readonly<IncomingHttpHeaders>,
  name: string,
): string | undefined {
  const value = headers[name];
  return typeof value === "string" && value !== ""
    ? value
    : undefined;
}

export function createPasskeyManagementRouteOperations(
  service: PasskeyManagementService,
): Pick<PasskeyRouteOperations, "list" | "rename" | "delete"> {
  if (
    typeof service !== "object" ||
    service === null ||
    typeof service.list !== "function" ||
    typeof service.rename !== "function" ||
    typeof service.remove !== "function"
  ) {
    throw new Error(
      "Passkey management service is incomplete.",
    );
  }

  function operationResult(
    outcome: Awaited<ReturnType<PasskeyManagementService["list"]>>,
  ): PasskeyOperationResult {
    return Object.freeze({
      ...outcome,
      setCookies: Object.freeze([]),
    });
  }

  return Object.freeze({
    async list({ context }) {
      return operationResult(
        await service.list({
          session: managementSession(context),
          requestId: context.requestId,
        }),
      );
    },
    async rename({ context, value }) {
      return operationResult(
        await service.rename({
          session: managementSession(context),
          requestId: context.requestId,
          id: value.id,
          name: value.name,
        }),
      );
    },
    async delete({ context, value }) {
      return operationResult(
        await service.remove({
          session: managementSession(context),
          requestId: context.requestId,
          networkSource:
            singleHeader(context.headers, "x-real-ip") ?? "",
          requestOrigin:
            singleHeader(context.headers, "origin"),
          id: value.id,
          proof: value.proof,
        }),
      );
    },
  });
}

const OPERATION_NAMES:
  readonly PasskeyRouteOperation[] =
  Object.freeze([
    "registrationOptions",
    "registrationVerify",
    "authenticationOptions",
    "authenticationVerify",
    "list",
    "rename",
    "delete",
  ]);

function validateDependencies(
  dependencies:
    PasskeyRouterDependencies,
): void {
  if (
    typeof dependencies !== "object" ||
    dependencies === null ||
    typeof dependencies.operations !==
      "object" ||
    dependencies.operations === null ||
    typeof dependencies.secureCookies !==
      "boolean" ||
    typeof dependencies.managementSecurity !== "object" ||
    dependencies.managementSecurity === null ||
    typeof dependencies.managementSecurity.requireSession !== "function" ||
    typeof dependencies.managementSecurity.requireTrustedOrigin !== "function" ||
    OPERATION_NAMES.some(
      (name) =>
        typeof dependencies.operations[
          name
        ] !== "function",
    )
  ) {
    throw new Error(
      "Passkey route dependencies are incomplete.",
    );
  }
}

function routeContext(
  request: Request,
  response: Response,
  operation: PasskeyRouteOperation,
): PasskeyRouteContext {
  const management =
    operation === "list" ||
    operation === "rename" ||
    operation === "delete";
  return Object.freeze({
    headers: Object.freeze({
      ...request.headers,
    }),
    requestId:
      getRequestId(response),
    ...(management
      ? { currentSession: getCurrentSessionContext(response) }
      : {}),
  });
}

export function createPasskeyRouter(
  dependencies:
    PasskeyRouterDependencies,
) {
  validateDependencies(dependencies);
  const router = Router();

  const dispatch = async (
    operation: PasskeyRouteOperation,
    request: Request,
    response: Response,
    value: unknown,
  ): Promise<void> => {
    let result:
      PasskeyOperationResult;
    try {
      const execute =
        dependencies.operations[
          operation
        ] as PasskeyOperation<unknown>;
      result = await execute({
        context:
          routeContext(
            request,
            response,
            operation,
          ),
        value,
      });
    } catch (error) {
      if (
        error instanceof
        PasskeyPublicError
      ) {
        throw error;
      }
      throw new PasskeyPublicError(
        "PASSKEY_UNAVAILABLE",
      );
    }

    const prepared =
      preparePasskeyPublicResponse(
        operation,
        result,
        dependencies.secureCookies,
        getRequestId(response),
      );

    appendValidatedPasskeyCookies(
      response,
      prepared,
    );

    if (prepared.status === 204) {
      response.status(204).end();
      return;
    }
    response
      .status(prepared.status)
      .json(prepared.body);
  };

  router.use(
    passkeySensitiveHeaders,
  );

  router.post(
    "/registration/options",
    (request, response) =>
      dispatch(
        "registrationOptions",
        request,
        response,
        parseRegistrationOptionsBody(
          request.body,
        ),
      ),
  );
  router.post(
    "/registration/verify",
    (request, response) =>
      dispatch(
        "registrationVerify",
        request,
        response,
        parseRegistrationVerifyBody(
          request.body,
        ),
      ),
  );
  router.post(
    "/authentication/options",
    (request, response) =>
      dispatch(
        "authenticationOptions",
        request,
        response,
        parseAuthenticationOptionsBody(
          request.body,
        ),
      ),
  );
  router.post(
    "/authentication/verify",
    (request, response) =>
      dispatch(
        "authenticationVerify",
        request,
        response,
        parseAuthenticationVerifyBody(
          request.body,
        ),
      ),
  );
  router.get(
    "/",
    dependencies.managementSecurity.requireSession,
    (request, response) =>
      dispatch(
        "list",
        request,
        response,
        parsePasskeyListBody(
          request.body,
        ),
      ),
  );
  router.post(
    "/:id/rename",
    dependencies.managementSecurity.requireTrustedOrigin,
    dependencies.managementSecurity.requireSession,
    (request, response) => {
      const body =
        parsePasskeyRenameBody(
          request.body,
        );
      return dispatch(
        "rename",
        request,
        response,
        Object.freeze({
          id: parsePasskeyId(
            request.params.id,
          ),
          name: body.name,
        }),
      );
    },
  );
  router.post(
    "/:id/delete",
    dependencies.managementSecurity.requireTrustedOrigin,
    dependencies.managementSecurity.requireSession,
    (request, response) =>
      dispatch(
        "delete",
        request,
        response,
        Object.freeze({
          id: parsePasskeyId(
            request.params.id,
          ),
          proof:
            parsePasskeyDeleteBody(
              request.body,
            ),
        }),
      ),
  );

  router.use(
    () => {
      throw new PasskeyPublicError(
        "PASSKEY_NOT_FOUND",
      );
    },
  );
  router.use(passkeyErrorHandler);

  return router;
}
