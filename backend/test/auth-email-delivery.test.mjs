import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createAuthEmailDelivery,
  loadAuthEmailEnv,
} from "../dist/auth/email-delivery.js";

test(
  "local email capture is allowed for loopback auth URL",
  () => {
    const env =
      loadAuthEmailEnv(
        "http://localhost:8080",
        {
          AUTH_EMAIL_DELIVERY_MODE:
            "local_capture",

          AUTH_EMAIL_CAPTURE_DIR:
            "/tmp/delta-auth-mailbox",
        },
      );

    assert.equal(
      env.mode,
      "local_capture",
    );
  },
);

test(
  "local email capture is rejected for public auth URL",
  () => {
    assert.throws(
      () =>
        loadAuthEmailEnv(
          "https://delta.example.com",
          {
            AUTH_EMAIL_DELIVERY_MODE:
              "local_capture",
          },
        ),
      /allowed only with a loopback/,
    );
  },
);

test(
  "email capture directory must be absolute",
  () => {
    assert.throws(
      () =>
        loadAuthEmailEnv(
          "http://localhost:8080",
          {
            AUTH_EMAIL_DELIVERY_MODE:
              "local_capture",

            AUTH_EMAIL_CAPTURE_DIR:
              "relative/mailbox",
          },
        ),
      /must be an absolute path/,
    );
  },
);

test(
  "SMTP environment accepts explicit TLS configuration",
  () => {
    const env =
      loadAuthEmailEnv(
        "http://localhost:8080",
        {
          AUTH_EMAIL_DELIVERY_MODE:
            "smtp",

          SMTP_HOST:
            "smtp.mail.ru",

          SMTP_PORT:
            "465",

          SMTP_SECURE:
            "true",

          SMTP_USER:
            "info@example.test",

          SMTP_PASS:
            "secret",

          SMTP_FROM:
            "info@example.test",
        },
      );

    assert.equal(
      env.mode,
      "smtp",
    );

    assert.equal(
      env.host,
      "smtp.mail.ru",
    );

    assert.equal(
      env.port,
      465,
    );

    assert.equal(
      env.secure,
      true,
    );
  },
);

test(
  "SMTP environment requires password",
  () => {
    assert.throws(
      () =>
        loadAuthEmailEnv(
          "http://localhost:8080",
          {
            AUTH_EMAIL_DELIVERY_MODE:
              "smtp",

            SMTP_HOST:
              "smtp.mail.ru",

            SMTP_PORT:
              "465",

            SMTP_SECURE:
              "true",

            SMTP_USER:
              "info@example.test",

            SMTP_FROM:
              "info@example.test",
          },
        ),
      /SMTP_PASS is required/,
    );
  },
);

test(
  "SMTP environment rejects invalid port",
  () => {
    assert.throws(
      () =>
        loadAuthEmailEnv(
          "http://localhost:8080",
          {
            AUTH_EMAIL_DELIVERY_MODE:
              "smtp",

            SMTP_HOST:
              "smtp.mail.ru",

            SMTP_PORT:
              "70000",

            SMTP_SECURE:
              "true",

            SMTP_USER:
              "info@example.test",

            SMTP_PASS:
              "secret",

            SMTP_FROM:
              "info@example.test",
          },
        ),
      /between 1 and 65535/,
    );
  },
);

test(
  "SMTP environment rejects header injection",
  () => {
    assert.throws(
      () =>
        loadAuthEmailEnv(
          "http://localhost:8080",
          {
            AUTH_EMAIL_DELIVERY_MODE:
              "smtp",

            SMTP_HOST:
              "smtp.mail.ru",

            SMTP_PORT:
              "465",

            SMTP_SECURE:
              "true",

            SMTP_USER:
              "info@example.test",

            SMTP_PASS:
              "secret",

            SMTP_FROM:
              "safe@example.test\nBcc: attacker@example.test",
          },
        ),
      /must not contain line breaks/,
    );
  },
);

test(
  "local email capture stores verification link with restrictive permissions",
  async () => {
    const directory =
      await mkdtemp(
        join(
          tmpdir(),
          "delta-auth-mail-",
        ),
      );

    try {
      const delivery =
        createAuthEmailDelivery({
          mode:
            "local_capture",

          captureDirectory:
            directory,
        });

      await delivery.verify();

      await delivery.send({
        kind:
          "email_verification",

        to:
          "user@example.test",

        url:
          "http://localhost:8080/api/auth/verify-email?token=secret",
      });

      const files =
        await readdir(
          directory,
        );

      assert.equal(
        files.length,
        1,
      );

      const target =
        join(
          directory,
          files[0],
        );

      const metadata =
        await stat(target);

      assert.equal(
        metadata.mode & 0o777,
        0o600,
      );

      const payload =
        JSON.parse(
          await readFile(
            target,
            "utf8",
          ),
        );

      assert.equal(
        payload.kind,
        "email_verification",
      );
    } finally {
      await rm(
        directory,
        {
          recursive: true,
          force: true,
        },
      );
    }
  },
);

test(
  "local email capture supports password reset messages",
  async () => {
    const directory =
      await mkdtemp(
        join(
          tmpdir(),
          "delta-auth-reset-mail-",
        ),
      );

    try {
      const delivery =
        createAuthEmailDelivery({
          mode:
            "local_capture",

          captureDirectory:
            directory,
        });

      await delivery.send({
        kind:
          "password_reset",

        to:
          "user@example.test",

        url:
          "http://localhost:8080/api/auth/reset-password/example-token",
      });

      const files =
        await readdir(
          directory,
        );

      assert.equal(
        files.length,
        1,
      );
    } finally {
      await rm(
        directory,
        {
          recursive: true,
          force: true,
        },
      );
    }
  },
);
