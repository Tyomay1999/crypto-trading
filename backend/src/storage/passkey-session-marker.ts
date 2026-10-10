import type { DBTransactionAdapter } from "better-auth";

export type PasskeyCredentialDeviceType = "singleDevice" | "multiDevice";

export type PasskeySessionMarkerInput = {
  sessionId: string;
  passkeyId: string | null;
  userVerified: true;
  credentialDeviceType: PasskeyCredentialDeviceType;
  credentialBackedUp: boolean;
  authenticatedAt: Date;
  aaguid: string | null;
  transports: string | null;
};

export async function insertPasskeySessionMarker(
  adapter: DBTransactionAdapter,
  marker: PasskeySessionMarkerInput,
): Promise<void> {
  if (
    !marker.sessionId ||
    (marker.passkeyId !== null && !marker.passkeyId) ||
    marker.userVerified !== true ||
    !["singleDevice", "multiDevice"].includes(
      marker.credentialDeviceType,
    ) ||
    typeof marker.credentialBackedUp !== "boolean" ||
    !Number.isFinite(marker.authenticatedAt.getTime()) ||
    (marker.aaguid !== null && typeof marker.aaguid !== "string") ||
    (marker.transports !== null && typeof marker.transports !== "string")
  ) {
    throw new Error("Invalid passkey provenance.");
  }

  const inserted = await adapter.create({
    model: "passkeySessionMarker",
    data: marker,
  });
  if (!inserted) throw new Error("Passkey provenance insertion failed.");
}
