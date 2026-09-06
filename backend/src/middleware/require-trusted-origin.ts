import type {
  RequestHandler,
} from "express";

import {
  AppError,
} from "../errors/app-error.js";

function parseHttpOrigin(
  value: string,
  allowPath: boolean,
): string | null {
  if (value === "null") {
    return null;
  }

  try {
    const url =
      new URL(value);

    if (
      url.protocol !== "http:" &&
      url.protocol !== "https:"
    ) {
      return null;
    }

    if (
      url.username.length > 0 ||
      url.password.length > 0
    ) {
      return null;
    }

    /*
     * The Origin header represents an origin,
     * never a navigational URL.
     *
     * Referer may legitimately contain a path,
     * query and fragment.
     */
    if (
      !allowPath &&
      (
        url.pathname !== "/" ||
        url.search.length > 0 ||
        url.hash.length > 0
      )
    ) {
      return null;
    }

    return url.origin;
  } catch {
    return null;
  }
}

function normalizeTrustedOrigins(
  trustedOrigins:
    readonly string[],
): ReadonlySet<string> {
  const normalized =
    new Set<string>();

  for (
    const value of trustedOrigins
  ) {
    const origin =
      parseHttpOrigin(
        value,
        true,
      );

    if (origin === null) {
      throw new Error(
        "Trusted origin configuration contains an invalid HTTP origin.",
      );
    }

    normalized.add(
      origin,
    );
  }

  return normalized;
}

function getRequestOrigin(
  originHeader:
    string | undefined,
  refererHeader:
    string | undefined,
): string | null {
  /*
   * If Origin exists, it is authoritative.
   * An invalid Origin must not fall back to
   * a potentially trusted Referer.
   */
  if (originHeader !== undefined) {
    return parseHttpOrigin(
      originHeader,
      false,
    );
  }

  if (refererHeader !== undefined) {
    return parseHttpOrigin(
      refererHeader,
      true,
    );
  }

  return null;
}

export function createRequireTrustedOriginMiddleware(
  trustedOrigins:
    readonly string[],
): RequestHandler {
  const acceptedOrigins =
    normalizeTrustedOrigins(
      trustedOrigins,
    );

  return (
    request,
    _response,
    next,
  ) => {
    const requestOrigin =
      getRequestOrigin(
        request.get(
          "origin",
        ),
        request.get(
          "referer",
        ),
      );

    if (requestOrigin === null) {
      next(
        new AppError(
          403,
          "TRUSTED_ORIGIN_REQUIRED",
          "A trusted request origin is required.",
        ),
      );

      return;
    }

    if (
      !acceptedOrigins.has(
        requestOrigin,
      )
    ) {
      next(
        new AppError(
          403,
          "UNTRUSTED_ORIGIN",
          "The request origin is not trusted.",
        ),
      );

      return;
    }

    next();
  };
}
