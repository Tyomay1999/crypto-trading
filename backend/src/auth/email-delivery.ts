import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  writeFile,
} from "node:fs/promises";
import {
  isAbsolute,
  join,
} from "node:path";

import nodemailer from "nodemailer";

export type AuthEmailMessage = Readonly<{
  kind:
    | "email_verification"
    | "password_reset";
  to: string;
  url: string;
}>;

export interface AuthEmailDelivery {
  send(
    message: AuthEmailMessage,
  ): Promise<void>;

  verify(): Promise<void>;
}

type LocalCaptureEmailEnvironment =
  Readonly<{
    mode: "local_capture";
    captureDirectory: string;
  }>;

type SmtpEmailEnvironment =
  Readonly<{
    mode: "smtp";

    host: string;
    port: number;
    secure: boolean;

    user: string;
    pass: string;
    from: string;
  }>;

export type AuthEmailEnvironment =
  | LocalCaptureEmailEnvironment
  | SmtpEmailEnvironment;

function required(
  source: NodeJS.ProcessEnv,
  name: string,
): string {
  const value =
    source[name]?.trim();

  if (!value) {
    throw new Error(
      `${name} is required`,
    );
  }

  return value;
}

function parsePort(
  value: string,
): number {
  if (!/^[0-9]+$/.test(value)) {
    throw new Error(
      "SMTP_PORT must be an integer",
    );
  }

  const port = Number(value);

  if (
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    throw new Error(
      "SMTP_PORT must be between 1 and 65535",
    );
  }

  return port;
}

function parseBoolean(
  value: string,
  name: string,
): boolean {
  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  throw new Error(
    `${name} must be true or false`,
  );
}

function rejectHeaderInjection(
  value: string,
  name: string,
): string {
  if (
    value.includes("\r") ||
    value.includes("\n")
  ) {
    throw new Error(
      `${name} must not contain line breaks`,
    );
  }

  return value;
}

function isLoopbackHostname(
  hostname: string,
): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1"
  );
}

export function loadAuthEmailEnv(
  authBaseUrl: string,
  source: NodeJS.ProcessEnv = process.env,
): AuthEmailEnvironment {
  const baseUrl =
    new URL(authBaseUrl);

  const mode =
    required(
      source,
      "AUTH_EMAIL_DELIVERY_MODE",
    );

  if (mode === "local_capture") {
    if (
      !isLoopbackHostname(
        baseUrl.hostname,
      )
    ) {
      throw new Error(
        "AUTH_EMAIL_DELIVERY_MODE=local_capture is allowed only with a loopback BETTER_AUTH_BASE_URL.",
      );
    }

    const captureDirectory =
      source.AUTH_EMAIL_CAPTURE_DIR?.trim() ||
      "/tmp/delta-auth-mailbox";

    if (
      !isAbsolute(
        captureDirectory,
      )
    ) {
      throw new Error(
        "AUTH_EMAIL_CAPTURE_DIR must be an absolute path.",
      );
    }

    return Object.freeze({
      mode,
      captureDirectory,
    });
  }

  if (mode === "smtp") {
    const host =
      rejectHeaderInjection(
        required(
          source,
          "SMTP_HOST",
        ),
        "SMTP_HOST",
      );

    const port =
      parsePort(
        required(
          source,
          "SMTP_PORT",
        ),
      );

    const secure =
      parseBoolean(
        required(
          source,
          "SMTP_SECURE",
        ),
        "SMTP_SECURE",
      );

    const user =
      rejectHeaderInjection(
        required(
          source,
          "SMTP_USER",
        ),
        "SMTP_USER",
      );

    const pass =
      required(
        source,
        "SMTP_PASS",
      );

    const from =
      rejectHeaderInjection(
        required(
          source,
          "SMTP_FROM",
        ),
        "SMTP_FROM",
      );

    return Object.freeze({
      mode,
      host,
      port,
      secure,
      user,
      pass,
      from,
    });
  }

  throw new Error(
    "AUTH_EMAIL_DELIVERY_MODE must be local_capture or smtp.",
  );
}

function renderAuthEmail(
  message: AuthEmailMessage,
): Readonly<{
  subject: string;
  text: string;
}> {
  switch (message.kind) {
    case "email_verification":
      return {
        subject:
          "Delta — Verify your email",
        text: [
          "Verify your Delta email address:",
          "",
          message.url,
          "",
          "This verification link expires in 1 hour.",
          "",
          "If you did not create a Delta account, you can ignore this email.",
        ].join("\n"),
      };

    case "password_reset":
      return {
        subject:
          "Delta — Reset your password",
        text: [
          "A password reset was requested for your Delta account.",
          "",
          "Use this link to continue:",
          "",
          message.url,
          "",
          "This reset link expires in 1 hour and can be used only once.",
          "",
          "If you did not request this reset, you can ignore this email.",
        ].join("\n"),
      };
  }
}

function createLocalCaptureDelivery(
  env: LocalCaptureEmailEnvironment,
): AuthEmailDelivery {
  return {
    verify: () =>
      Promise.resolve(),

    async send(
      message: AuthEmailMessage,
    ): Promise<void> {
      await mkdir(
        env.captureDirectory,
        {
          recursive: true,
          mode: 0o700,
        },
      );

      await chmod(
        env.captureDirectory,
        0o700,
      );

      const filename =
        `${Date.now()}-${randomUUID()}.json`;

      const target =
        join(
          env.captureDirectory,
          filename,
        );

      const payload =
        JSON.stringify({
          kind:
            message.kind,
          to:
            message.to,
          url:
            message.url,
          createdAt:
            new Date().toISOString(),
        });

      await writeFile(
        target,
        `${payload}\n`,
        {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        },
      );
    },
  };
}

function createSmtpDelivery(
  env: SmtpEmailEnvironment,
): AuthEmailDelivery {
  const transporter =
    nodemailer.createTransport({
      host:
        env.host,

      port:
        env.port,

      secure:
        env.secure,

      auth: {
        user:
          env.user,
        pass:
          env.pass,
      },

      connectionTimeout:
        10_000,

      greetingTimeout:
        10_000,

      socketTimeout:
        20_000,
    });

  return {
    async verify(): Promise<void> {
      await transporter.verify();
    },

    async send(
      message: AuthEmailMessage,
    ): Promise<void> {
      const rendered =
        renderAuthEmail(
          message,
        );

      await transporter.sendMail({
        from:
          env.from,

        to:
          message.to,

        subject:
          rendered.subject,

        text:
          rendered.text,
      });
    },
  };
}

export function createAuthEmailDelivery(
  env: AuthEmailEnvironment,
): AuthEmailDelivery {
  switch (env.mode) {
    case "local_capture":
      return createLocalCaptureDelivery(
        env,
      );

    case "smtp":
      return createSmtpDelivery(
        env,
      );
  }
}
