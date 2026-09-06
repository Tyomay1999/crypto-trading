import { betterAuth } from "better-auth";
import type { Pool } from "pg";

import type {
  AuthEnvironment,
} from "./config.js";

export function createDeltaAuth(
  database: Pool,
  env: AuthEnvironment,
) {
  return betterAuth({
    appName: "Delta",

    baseURL: env.baseUrl,
    basePath: "/api/auth",

    secret: env.secret,

    trustedOrigins: [
      ...env.trustedOrigins,
    ],

    database,

    /*
     * A1 intentionally enables no login method yet.
     *
     * Email/password is enabled in A2 only after
     * password policy, verification and recovery
     * contracts are accepted.
     */

    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,

      /*
       * Database-backed validation is intentional.
       * Immediate session revocation is more
       * important to Delta than cookie caching.
       */
      cookieCache: {
        enabled: false,
      },
    },

    verification: {
      storeIdentifier: "hashed",
    },

    account: {
      /*
       * Future OAuth tokens must never be persisted
       * as plaintext.
       */
      encryptOAuthTokens: true,
    },

    advanced: {
      cookiePrefix: "delta-auth",

      useSecureCookies:
        env.useSecureCookies,

      /*
       * Delta's reverse proxy overwrites
       * X-Real-IP at the application boundary.
       * Never accept arbitrary forwarded chains.
       */
      ipAddress: {
        ipAddressHeaders: [
          "x-real-ip",
        ],
      },

      database: {
        joins: true,
        validateSchema: true,
      },
    },
  });
}

export type DeltaAuth =
  ReturnType<typeof createDeltaAuth>;
