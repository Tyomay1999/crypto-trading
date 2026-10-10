import { recoveryCodePlugin } from "./recovery-code-plugin.js";
import { deltaPasskeySchemaOverlayPlugin } from "./passkey-schema.js";
import { passkeyPublicPlugin } from "./passkey-public-plugin.js";
import {
  AUTH_PASSWORD_MAX_LENGTH,
  AUTH_PASSWORD_MIN_LENGTH,
} from "./password-policy.js";

import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { twoFactor } from "better-auth/plugins/two-factor";
import type { Pool } from "pg";

import {
  createEmailVerificationReplayHook,
} from "./email-verification-replay.js";

import type {
  AuthEnvironment,
} from "./config.js";
import type {
  AuthEmailDelivery,
} from "./email-delivery.js";
import type {
  PasskeyTestTransactionSelectorCapability,
} from "./passkey-test-transaction-selector.js";

export function createDeltaAuth(
  database: Pool,
  env: AuthEnvironment,
  emailDelivery: AuthEmailDelivery,
  testTransactionSelector?: PasskeyTestTransactionSelectorCapability,
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
     * Delta closes Better Auth 1.7.3
     * stateless email-verification replay
     * before the endpoint handler can take
     * its already-verified success branch.
     */
    hooks: {
      before:
        createEmailVerificationReplayHook(
          database,
        ),
    },

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
      "/delta-recovery/status",
      "/delta-recovery/generate",
      "/delta-recovery/regenerate",
      "/delta-recovery/verify",
      /*
       * A3 owns public session management.
       */
      "/list-sessions",
      "/revoke-session",
      "/revoke-sessions",
      "/revoke-other-sessions",

      /*
       * A4 owns the public strong-auth surface.
       *
       * Server-side auth.api.* remains available,
       * while raw Better Auth MFA routes must not
       * bypass Delta origin, replay, recent-auth
       * and audit controls.
       */
      "/two-factor/enable",
      "/two-factor/disable",
      "/two-factor/get-totp-uri",
      "/two-factor/verify-totp",
      "/two-factor/verify-backup-code",
      "/two-factor/generate-backup-codes",
      "/two-factor/send-otp",
      "/two-factor/verify-otp",

      /*
       * Delta owns every public passkey policy boundary. The official
       * plugin remains registered for its model contract, but none of its
       * seven raw HTTP endpoints may bypass Delta ceremony wrappers.
       */
      "/passkey/generate-register-options",
      "/passkey/generate-authenticate-options",
      "/passkey/verify-registration",
      "/passkey/verify-authentication",
      "/passkey/list-user-passkeys",
      "/passkey/delete-passkey",
      "/passkey/update-passkey",

      /*
       * Delta's enrollment bridge is callable only through auth.api.*.
       * Its raw Better Auth HTTP paths remain contained until the
       * separately protected Express wrapper is mounted in C2-I6.
       */
      "/delta-passkey/enrollment/options",
      "/delta-passkey/enrollment/verify",
      "/delta-passkey/authentication/options",
      "/delta-passkey/authentication/verify",
    ],

    database,


    /*
     * A4-A1 strong-auth foundation.
     *
     * Better Auth owns encrypted TOTP secret
     * persistence and the credential-login
     * second-factor challenge lifecycle.
     *
     * Delta does not use Better Auth recovery
     * credentials. Real recovery credentials are
     * Delta-owned hash-only state introduced in
     * A4-B.
     */
    plugins: [
      recoveryCodePlugin(database, env),
      twoFactor({
        issuer: "Delta",

        skipVerificationOnEnable:
          false,

        allowPasswordless:
          false,

        twoFactorCookieMaxAge:
          10 * 60,

        accountLockout: {
          enabled: true,

          maxFailedAttempts: 10,

          durationSeconds:
            15 * 60,
        },

        totpOptions: {
          digits: 6,
          period: 30,

          allowPasswordless:
            false,
        },

        backupCodeOptions: {
          /*
           * Better Auth backup-code storage is
           * reversible. Delta deliberately gives
           * the plugin no usable recovery codes.
           */
          customBackupCodesGenerate:
            () => [],

          storeBackupCodes:
            "encrypted",

          allowPasswordless:
            false,
        },
      }),
      passkey({
        rpID: env.webauthn.rpId,
        rpName: env.webauthn.rpName,
        origin: env.webauthn.origin,
        authenticatorSelection: {
          userVerification:
            env.webauthn.userVerification,
          residentKey:
            env.webauthn.residentKey,
          requireResidentKey:
            env.webauthn.requireResidentKey,
        },
      }),
      // Ordering is security-critical: later schema fields replace the
      // official passkey attributes with Delta's BIGINT transforms and
      // migration ownership while retaining the official model contract.
      deltaPasskeySchemaOverlayPlugin,
      // The internal bridge depends on the official model plus Delta's
      // schema overlay and remains raw-HTTP disabled above.
      ...(testTransactionSelector === undefined
        ? [
            passkeyPublicPlugin(database, env),
          ]
        : [
            passkeyPublicPlugin(
              database,
              env,
              testTransactionSelector,
            ),
          ]),
    ],

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
