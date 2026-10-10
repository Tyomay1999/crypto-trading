import type {
  ErrorRequestHandler,
  RequestHandler,
} from "express";

import {
  AppError,
} from "../errors/app-error.js";
import {
  getRequestId,
} from "./request-context.js";

export const PASSKEY_PUBLIC_PREFIX =
  "/api/v1/auth/passkeys" as const;

export const PASSKEY_JSON_BODY_LIMIT =
  "64kb" as const;

export const PASSKEY_PUBLIC_GENERIC_MESSAGE =
  "Passkey request could not be completed." as const;

export const PASSKEY_SAFE_ERROR_CODES = [
  "PASSKEY_REQUEST_REJECTED",
  "PASSKEY_RATE_LIMITED",
  "PASSKEY_FRESH_PROOF_REJECTED",
  "PASSKEY_CREDENTIAL_CONFLICT",
  "PASSKEY_UNAVAILABLE",
  "PASSKEY_NOT_FOUND",
  "PASSKEY_LAST_LOGIN_METHOD_REQUIRED",
] as const;

export type PasskeySafePublicErrorCode =
  (typeof PASSKEY_SAFE_ERROR_CODES)[number];

export type PasskeyPublicErrorEnvelope =
  Readonly<{
    error: Readonly<{
      code: PasskeySafePublicErrorCode;
      message:
        typeof PASSKEY_PUBLIC_GENERIC_MESSAGE;
      requestId: string;
    }>;
  }>;

const PASSKEY_ERROR_STATUS =
  Object.freeze({
    PASSKEY_REQUEST_REJECTED: 400,
    PASSKEY_RATE_LIMITED: 429,
    PASSKEY_FRESH_PROOF_REJECTED: 401,
    PASSKEY_CREDENTIAL_CONFLICT: 409,
    PASSKEY_UNAVAILABLE: 503,
    PASSKEY_NOT_FOUND: 404,
    PASSKEY_LAST_LOGIN_METHOD_REQUIRED: 409,
  } satisfies Record<
    PasskeySafePublicErrorCode,
    number
  >);

export class PasskeyPublicError extends Error {
  readonly code:
    PasskeySafePublicErrorCode;

  constructor(
    code: PasskeySafePublicErrorCode,
  ) {
    super(
      PASSKEY_PUBLIC_GENERIC_MESSAGE,
    );
    this.name = "PasskeyPublicError";
    this.code = code;
  }
}

export function passkeyStatusForCode(
  code: PasskeySafePublicErrorCode,
): number {
  return PASSKEY_ERROR_STATUS[code];
}

export function createPasskeyPublicErrorEnvelope(
  code: PasskeySafePublicErrorCode,
  requestId: string,
): PasskeyPublicErrorEnvelope {
  return Object.freeze({
    error: Object.freeze({
      code,
      message:
        PASSKEY_PUBLIC_GENERIC_MESSAGE,
      requestId,
    }),
  });
}

type BodyParserError = Readonly<{
  type?: unknown;
}>;

function bodyParserType(
  error: unknown,
): string | null {
  if (
    typeof error !== "object" ||
    error === null ||
    !("type" in error)
  ) {
    return null;
  }
  const type =
    (error as BodyParserError).type;
  return typeof type === "string"
    ? type
    : null;
}

export function serializePasskeyPublicError(
  error: unknown,
  requestId: string,
): Readonly<{
  status: number;
  body: PasskeyPublicErrorEnvelope;
}> {
  const parserType =
    bodyParserType(error);

  if (
    parserType ===
    "entity.too.large"
  ) {
    return Object.freeze({
      status: 413,
      body:
        createPasskeyPublicErrorEnvelope(
          "PASSKEY_REQUEST_REJECTED",
          requestId,
        ),
    });
  }

  if (
    parserType ===
    "entity.parse.failed"
  ) {
    return Object.freeze({
      status: 400,
      body:
        createPasskeyPublicErrorEnvelope(
          "PASSKEY_REQUEST_REJECTED",
          requestId,
        ),
    });
  }

  if (
    error instanceof
    PasskeyPublicError
  ) {
    return Object.freeze({
      status:
        passkeyStatusForCode(
          error.code,
        ),
      body:
        createPasskeyPublicErrorEnvelope(
          error.code,
          requestId,
        ),
    });
  }

  /*
   * Session and trusted-origin middleware retain
   * ownership of their decisions, but this
   * sensitive surface emits one finite public
   * passkey vocabulary. No AppError detail is
   * reflected.
   */
  if (
    error instanceof AppError &&
    error.statusCode === 401
  ) {
    return Object.freeze({
      status: 401,
      body:
        createPasskeyPublicErrorEnvelope(
          "PASSKEY_REQUEST_REJECTED",
          requestId,
        ),
    });
  }

  if (
    error instanceof AppError &&
    error.statusCode === 403
  ) {
    return Object.freeze({
      status: 403,
      body:
        createPasskeyPublicErrorEnvelope(
          "PASSKEY_REQUEST_REJECTED",
          requestId,
        ),
    });
  }

  return Object.freeze({
    status: 503,
    body:
      createPasskeyPublicErrorEnvelope(
        "PASSKEY_UNAVAILABLE",
        requestId,
      ),
  });
}

export const passkeySensitiveHeaders:
  RequestHandler = (
    request,
    response,
    next,
  ) => {
    response.set(
      "Cache-Control",
      "no-store",
    );
    response.set(
      "Pragma",
      "no-cache",
    );

    /*
     * The passkey surface must not let an
     * attacker-chosen correlation value become
     * security-audit metadata. The request-context
     * middleware supplies the replacement later.
     */
    delete request.headers[
      "x-request-id"
    ];
    next();
  };

export const passkeyErrorHandler:
  ErrorRequestHandler = (
    error,
    _request,
    response,
    _next,
  ) => {
    /*
     * Cookies are released only by a route after
     * its complete internal result has passed the
     * allowlist validator. Any error path drops
     * pending or unvalidated cookies.
     */
    response.removeHeader(
      "Set-Cookie",
    );
    response.set(
      "Cache-Control",
      "no-store",
    );
    response.set(
      "Pragma",
      "no-cache",
    );

    const serialized =
      serializePasskeyPublicError(
        error,
        getRequestId(response),
      );

    response
      .status(serialized.status)
      .json(serialized.body);
  };
