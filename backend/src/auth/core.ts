import {
  AUTH_PASSWORD_MAX_LENGTH,
  AUTH_PASSWORD_MIN_LENGTH,
} from "./password-policy.js";

import { betterAuth } from "better-auth";
import type { Pool } from "pg";

import type {
  AuthEnvironment,
} from "./config.js";
import type {
  AuthEmailDelivery,
} from "./email-delivery.js";

export function createDeltaAuth(
  database: Pool,
  env: AuthEnvironment,
  emailDelivery: AuthEmailDelivery,
) {
  return betterAuth({
    appName: "Delta",

    baseURL: env.baseUrl,
    basePath: "/api/auth",

    secret: env.secret,

    trustedOrigins: [
      ...env.trustedOrigins,
    ],

    /*
     * A3 owns the public session-management
     * surface. These Better Auth HTTP routes
     * expose lower-level Session/token contracts
     * and must not bypass Delta's sanitized API.
     *
     * Programmatic auth.api.* calls remain
     * available server-side.
     */
    disabledPaths: [
      "/list-sessions",
      "/revoke-session",
      "/revoke-sessions",
      "/revoke-other-sessions",
    ],

    database,

    /*
     * A1 intentionally enables no login method yet.
     *
     * Email/password is enabled in A2 only after
     * password policy, verification and recovery
     * contracts are accepted.
     */

    /*
     * A2-A establishes credential authentication.
     *
     * Registration must not create a session.
     * Email verification becomes mandatory in A2-B,
     * after the delivery contract is installed.
     */
    emailAndPassword: {
      enabled: true,
      disableSignUp: false,
      requireEmailVerification: true,
      minPasswordLength:
        AUTH_PASSWORD_MIN_LENGTH,
      maxPasswordLength:
        AUTH_PASSWORD_MAX_LENGTH,
      autoSignIn: false,

      /*
       * Reset email delivery is intentionally
       * started without awaiting it so account
       * existence is not exposed through an
       * obvious delivery-time side channel.
       *
       * Delivery errors are redacted: never
       * include recipient, URL or token.
       */
      sendResetPassword: async ({
        user,
        url,
      }) => {
        void emailDelivery
          .send({
            kind:
              "password_reset",
            to: user.email,
            url,
          })
          .catch(() => {
            console.error(
              JSON.stringify({
                event:
                  "auth_email_delivery_failed",
                kind:
                  "password_reset",
              }),
            );
          });
      },

      onPasswordReset: async () => {
        console.log(
          JSON.stringify({
            event:
              "auth_password_reset_completed",
          }),
        );
      },
      revokeSessionsOnPasswordReset: true,
      resetPasswordTokenExpiresIn:
        60 * 60,
    },

    emailVerification: {
      /*
       * Verification links are authentication
       * credentials and must never be logged.
       */
      sendVerificationEmail: async ({
        user,
        url,
      }) => {
        void emailDelivery
          .send({
            kind:
              "email_verification",
            to: user.email,
            url,
          })
          .catch(() => {
            /*
             * Deliberately omit recipient,
             * URL and token from logs.
             */
            console.error(
              JSON.stringify({
                event:
                  "auth_email_delivery_failed",
                kind:
                  "email_verification",
              }),
            );
          });
      },

      sendOnSignUp: true,

      /*
       * Do not automatically send another
       * email on every failed login attempt.
       * Explicit resend remains available.
       */
      sendOnSignIn: false,

      autoSignInAfterVerification:
        false,

      expiresIn: 60 * 60,
    },

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
