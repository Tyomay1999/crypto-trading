export type AuthEnvironment = Readonly<{
  secret: string;
  baseUrl: string;
  trustedOrigins: readonly string[];
  useSecureCookies: boolean;
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

export function loadAuthEnv(
  source: NodeJS.ProcessEnv = process.env,
): AuthEnvironment {
  const secret = requireSecret(
    source.BETTER_AUTH_SECRET,
  );

  const baseUrl = parseBaseUrl(
    source.BETTER_AUTH_BASE_URL,
  );

  const trustedOrigins =
    parseTrustedOrigins(
      source.BETTER_AUTH_TRUSTED_ORIGINS,
      baseUrl.origin,
    );

  return Object.freeze({
    secret,
    baseUrl: baseUrl.origin,
    trustedOrigins,
    useSecureCookies:
      baseUrl.protocol === "https:",
  });
}
