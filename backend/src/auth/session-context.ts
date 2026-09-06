import type {
  IncomingHttpHeaders,
} from "node:http";

import {
  fromNodeHeaders,
} from "better-auth/node";

import type {
  DeltaAuth,
} from "./core.js";

export type CurrentSessionContext =
  Readonly<{
    sessionId: string;
    userId: string;
  }>;

export type CurrentSessionResolution =
  Readonly<{
    context:
      CurrentSessionContext | null;

    /*
     * Only Better Auth Set-Cookie values are
     * propagated to the outgoing Express response.
     *
     * The full Better Auth Session object and its
     * bearer token never enter Delta route context.
     */
    setCookies:
      readonly string[];
  }>;

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

function getSetCookies(
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
    throw new Error(
      "Runtime must support Headers.getSetCookie().",
    );
  }

  return Object.freeze([
    ...candidate.getSetCookie(),
  ]);
}

function parseSafeContext(
  payload: unknown,
): CurrentSessionContext | null {
  if (payload === null) {
    return null;
  }

  if (!isRecord(payload)) {
    throw new Error(
      "Better Auth returned an invalid session response.",
    );
  }

  const session =
    payload.session;

  if (!isRecord(session)) {
    throw new Error(
      "Better Auth returned an invalid session object.",
    );
  }

  const sessionId =
    session.id;

  const userId =
    session.userId;

  if (
    typeof sessionId !== "string" ||
    sessionId.length === 0 ||
    typeof userId !== "string" ||
    userId.length === 0
  ) {
    throw new Error(
      "Better Auth returned an invalid session identity.",
    );
  }

  return Object.freeze({
    sessionId,
    userId,
  });
}

export async function resolveCurrentSession(
  auth: DeltaAuth,
  headers: IncomingHttpHeaders,
): Promise<CurrentSessionResolution> {
  /*
   * asResponse is intentional.
   *
   * Better Auth may refresh the durable session
   * after updateAge and issue a replacement
   * session cookie. A custom Express integration
   * must forward that Set-Cookie header or the
   * browser cookie and DB expiry can diverge.
   */
  const authResponse =
    await auth.api.getSession({
      headers:
        fromNodeHeaders(
          headers,
        ),
      asResponse: true,
    });

  const setCookies =
    getSetCookies(
      authResponse.headers,
    );

  if (!authResponse.ok) {
    throw new Error(
      `Better Auth session resolution failed with HTTP ${authResponse.status}.`,
    );
  }

  const payload: unknown =
    await authResponse.json();

  return Object.freeze({
    context:
      parseSafeContext(
        payload,
      ),
    setCookies,
  });
}
