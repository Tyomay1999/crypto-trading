import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const nginxSource = await readFile(
  new URL("../nginx.conf", import.meta.url),
  "utf8",
);

const activeUrlSecretRoutes = [
  {
    requestTarget:
      "/api/auth/verify-email?token=synthetic-verification-token",
    location: "= /api/auth/verify-email",
  },
  {
    requestTarget:
      "/api/auth/reset-password?token=synthetic-reset-token",
    location: "= /api/auth/reset-password",
  },
  {
    requestTarget:
      "/api/auth/reset-password/synthetic-reset-token?callbackURL=%2Freset-complete",
    location: "/api/auth/reset-password/",
  },
];

function locationBody(prefix) {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = nginxSource.match(
    new RegExp(`location\\s+${escaped}\\s*\\{([\\s\\S]*?)\\n\\s*\\}`),
  );

  assert.ok(match, `missing Nginx location ${prefix}`);
  return match[1];
}

function assertPreservingProxy(body) {
  assert.match(body, /proxy_pass\s+http:\/\/backend:3001\s*;/);
  assert.doesNotMatch(body, /proxy_pass\s+http:\/\/backend:3001\/\s*;/);
}

function assertTrustedProxyParity(body) {
  assert.match(body, /proxy_http_version\s+1\.1\s*;/);
  assert.match(body, /proxy_set_header\s+Host\s+\$host\s*;/);
  assert.match(body, /proxy_set_header\s+X-Real-IP\s+\$remote_addr\s*;/);
  assert.match(body, /proxy_set_header\s+X-Forwarded-For\s+\$remote_addr\s*;/);
  assert.match(body, /proxy_set_header\s+X-Forwarded-Proto\s+\$scheme\s*;/);
}

function selectLocation(requestTarget) {
  const request = new URL(requestTarget, "http://frontend.test");

  const exactLocations = new Map([
    ["/api/auth/verify-email", "= /api/auth/verify-email"],
    ["/api/auth/reset-password", "= /api/auth/reset-password"],
  ]);
  const exact = exactLocations.get(request.pathname);

  if (exact) {
    return {
      location: exact,
      pathname: request.pathname,
      search: request.search,
    };
  }

  const prefixes = [
    "/api/auth/reset-password/",
    "/api/auth/",
    "/api/v1/",
    "/api/",
  ];
  const location = prefixes
    .filter((prefix) => request.pathname.startsWith(prefix))
    .sort((left, right) => right.length - left.length)[0];

  return { location, pathname: request.pathname, search: request.search };
}

function upstreamTarget(selection) {
  if (selection.location === "/api/") {
    return `${selection.pathname.slice("/api".length)}${selection.search}`;
  }

  return `${selection.pathname}${selection.search}`;
}

test("Nginx preserves Better Auth and versioned Delta paths while retaining legacy health routing", () => {
  const auth = locationBody("/api/auth/");
  const versioned = locationBody("/api/v1/");
  const generic = locationBody("/api/");

  assertPreservingProxy(auth);
  assertPreservingProxy(versioned);
  assertTrustedProxyParity(versioned);

  assert.match(generic, /proxy_pass\s+http:\/\/backend:3001\/\s*;/);
  assert.doesNotMatch(nginxSource, /\brewrite\b/);

  const prefixes = ["/api/auth/", "/api/v1/", "/api/"];
  const routes = new Map([
    ["/api/auth/sign-up/email", "/api/auth/"],
    ["/api/auth/sign-in/email", "/api/auth/"],
    ["/api/auth/get-session", "/api/auth/"],
    ["/api/v1/health", "/api/v1/"],
    ["/api/v1/health/live", "/api/v1/"],
    ["/api/v1/health/ready", "/api/v1/"],
    ["/api/v1/auth/sessions", "/api/v1/"],
    ["/api/v1/auth/mfa/totp/enroll", "/api/v1/"],
    ["/api/v1/auth/mfa/totp/enroll/verify", "/api/v1/"],
    ["/api/v1/auth/mfa/recovery-codes/status", "/api/v1/"],
    ["/api/v1/auth/mfa/recovery-codes/generate", "/api/v1/"],
    ["/api/v1/auth/mfa/recovery-codes/regenerate", "/api/v1/"],
    ["/api/v1/auth/mfa/recovery-codes/challenge/verify", "/api/v1/"],
    ["/api/health", "/api/"],
    ["/api/health/live", "/api/"],
    ["/api/health/ready", "/api/"],
  ]);

  for (const [path, expected] of routes) {
    const selected = prefixes
      .filter((prefix) => path.startsWith(prefix))
      .sort((left, right) => right.length - left.length)[0];
    assert.equal(selected, expected, path);
  }
});

test("Nginx excludes active auth URL credentials from access logs without changing routing", () => {
  const auth = locationBody("/api/auth/");
  const versioned = locationBody("/api/v1/");
  const generic = locationBody("/api/");

  for (const route of activeUrlSecretRoutes) {
    const protectedLocation = locationBody(route.location);
    const selection = selectLocation(route.requestTarget);

    assert.equal(selection.location, route.location, route.requestTarget);
    assert.equal(upstreamTarget(selection), route.requestTarget);
    assert.match(protectedLocation, /access_log\s+off\s*;/);
    assertPreservingProxy(protectedLocation);
    assertTrustedProxyParity(protectedLocation);
  }

  const verificationSelection = selectLocation(
    activeUrlSecretRoutes[0].requestTarget,
  );
  assert.equal(verificationSelection.location, "= /api/auth/verify-email");
  assert.equal(verificationSelection.pathname, "/api/auth/verify-email");
  assert.equal(
    verificationSelection.search,
    "?token=synthetic-verification-token",
  );

  const resetQuerySelection = selectLocation(
    activeUrlSecretRoutes[1].requestTarget,
  );
  assert.equal(resetQuerySelection.location, "= /api/auth/reset-password");
  assert.equal(resetQuerySelection.pathname, "/api/auth/reset-password");
  assert.equal(resetQuerySelection.search, "?token=synthetic-reset-token");

  const resetPathSelection = selectLocation(
    activeUrlSecretRoutes[2].requestTarget,
  );
  assert.equal(resetPathSelection.location, "/api/auth/reset-password/");
  assert.equal(
    resetPathSelection.pathname,
    "/api/auth/reset-password/synthetic-reset-token",
  );

  const ordinaryAuth = selectLocation("/api/auth/get-session");
  assert.equal(ordinaryAuth.location, "/api/auth/");
  assert.equal(upstreamTarget(ordinaryAuth), "/api/auth/get-session");
  assertPreservingProxy(auth);
  assert.doesNotMatch(auth, /access_log\s+off\s*;/);

  const siblingAuth = selectLocation("/api/auth/reset-password-something");
  assert.equal(siblingAuth.location, "/api/auth/");

  const versionedHealth = selectLocation("/api/v1/health");
  assert.equal(versionedHealth.location, "/api/v1/");
  assert.equal(upstreamTarget(versionedHealth), "/api/v1/health");
  assertPreservingProxy(versioned);

  const legacyHealth = selectLocation("/api/health");
  assert.equal(legacyHealth.location, "/api/");
  assert.equal(upstreamTarget(legacyHealth), "/health");
  assert.match(generic, /proxy_pass\s+http:\/\/backend:3001\/\s*;/);

  assert.equal(
    [...nginxSource.matchAll(/\baccess_log\s+off\s*;/g)].length,
    new Set(activeUrlSecretRoutes.map((route) => route.location)).size,
    "access logging must be disabled only for active URL-secret routes",
  );
  assert.doesNotMatch(nginxSource, /\brewrite\b/);
});
