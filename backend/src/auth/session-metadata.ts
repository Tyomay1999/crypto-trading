import {
  isIP,
} from "node:net";

import type {
  ActiveSessionRecord,
} from "../storage/session-inventory.js";

export type SafeBrowserFamily =
  | "Chrome"
  | "Edge"
  | "Firefox"
  | "Opera"
  | "Safari"
  | "Samsung Internet"
  | "Unknown";

export type SafeOperatingSystem =
  | "Android"
  | "ChromeOS"
  | "iOS"
  | "Linux"
  | "macOS"
  | "Windows"
  | "Unknown";

export type SafeDeviceType =
  | "desktop"
  | "mobile"
  | "tablet"
  | "unknown";

export type SafeDeviceMetadata =
  Readonly<{
    browser: SafeBrowserFamily;
    os: SafeOperatingSystem;
    type: SafeDeviceType;
  }>;

export type ManagedSessionView =
  Readonly<{
    id: string;
    current: boolean;
    createdAt: string;
    lastActivityAt: string;
    expiresAt: string;

    device: SafeDeviceMetadata;

    network:
      Readonly<{
        ipHint: string | null;
      }>;
  }>;

function detectBrowser(
  userAgent: string,
): SafeBrowserFamily {
  if (
    /Edg(?:A|iOS)?\//i.test(
      userAgent,
    )
  ) {
    return "Edge";
  }

  if (/OPR\//i.test(userAgent)) {
    return "Opera";
  }

  if (
    /Firefox\//i.test(userAgent) ||
    /FxiOS\//i.test(userAgent)
  ) {
    return "Firefox";
  }

  if (
    /SamsungBrowser\//i.test(
      userAgent,
    )
  ) {
    return "Samsung Internet";
  }

  if (
    /Chrome\//i.test(userAgent) ||
    /CriOS\//i.test(userAgent)
  ) {
    return "Chrome";
  }

  if (
    /Safari\//i.test(userAgent) &&
    /Version\//i.test(userAgent)
  ) {
    return "Safari";
  }

  return "Unknown";
}

function detectOperatingSystem(
  userAgent: string,
): SafeOperatingSystem {
  if (/Android/i.test(userAgent)) {
    return "Android";
  }

  if (
    /iPhone|iPad|iPod/i.test(
      userAgent,
    )
  ) {
    return "iOS";
  }

  if (/CrOS/i.test(userAgent)) {
    return "ChromeOS";
  }

  if (/Windows NT/i.test(userAgent)) {
    return "Windows";
  }

  if (/Macintosh/i.test(userAgent)) {
    return "macOS";
  }

  if (/Linux/i.test(userAgent)) {
    return "Linux";
  }

  return "Unknown";
}

function detectDeviceType(
  userAgent: string,
): SafeDeviceType {
  if (
    /iPad|Tablet/i.test(
      userAgent,
    )
  ) {
    return "tablet";
  }

  if (/Android/i.test(userAgent)) {
    return /Mobile/i.test(userAgent)
      ? "mobile"
      : "tablet";
  }

  if (
    /iPhone|iPod|Mobile/i.test(
      userAgent,
    )
  ) {
    return "mobile";
  }

  if (
    /Windows NT|Macintosh|CrOS|Linux/i.test(
      userAgent,
    )
  ) {
    return "desktop";
  }

  return "unknown";
}

/*
 * This is intentionally a coarse parser.
 *
 * No browser version, OS version, device model,
 * hardware information or persistent fingerprint
 * is produced.
 */
export function classifySessionDevice(
  userAgent: string | null,
): SafeDeviceMetadata {
  if (
    userAgent === null ||
    userAgent.trim().length === 0
  ) {
    return {
      browser: "Unknown",
      os: "Unknown",
      type: "unknown",
    };
  }

  return {
    browser:
      detectBrowser(userAgent),
    os:
      detectOperatingSystem(
        userAgent,
      ),
    type:
      detectDeviceType(
        userAgent,
      ),
  };
}

/*
 * IPv4 keeps only a coarse network hint.
 *
 * IPv6 is deliberately not partially exposed:
 * its prefix may carry more identifying
 * information than we need for device UI.
 */
export function maskSessionIp(
  ipAddress: string | null,
): string | null {
  if (
    ipAddress === null ||
    ipAddress.trim().length === 0
  ) {
    return null;
  }

  const normalized =
    ipAddress.trim();

  const family =
    isIP(normalized);

  if (family === 4) {
    const octets =
      normalized.split(".");

    return [
      octets[0],
      octets[1],
      octets[2],
      "xxx",
    ].join(".");
  }

  if (family === 6) {
    return "IPv6";
  }

  return null;
}

export function projectManagedSession(
  session: ActiveSessionRecord,
  currentSessionId: string,
): ManagedSessionView {
  return {
    id:
      session.sessionId,

    current:
      session.sessionId ===
      currentSessionId,

    createdAt:
      session.createdAt.toISOString(),

    lastActivityAt:
      session.lastActivityAt.toISOString(),

    expiresAt:
      session.expiresAt.toISOString(),

    device:
      classifySessionDevice(
        session.userAgent,
      ),

    network: {
      ipHint:
        maskSessionIp(
          session.ipAddress,
        ),
    },
  };
}

export function projectManagedSessions(
  sessions:
    readonly ActiveSessionRecord[],
  currentSessionId: string,
): ManagedSessionView[] {
  return sessions.map(
    (session) =>
      projectManagedSession(
        session,
        currentSessionId,
      ),
  );
}
