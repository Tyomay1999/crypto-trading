import type { BetterAuthPlugin } from "better-auth";

import {
  passkeyCounterFromDatabase,
  passkeyCounterToDatabase,
} from "./passkey-counter.js";

const requiredField = (
  type: "string" | "boolean" | "date",
  fieldName: string,
) => ({
  type,
  fieldName,
  required: true,
  input: false,
  returned: false,
});

export const deltaPasskeySchema = {
  // Registered after the official passkey plugin. Better Auth merges later
  // field attributes over the official model while retaining other fields.
  passkey: {
    modelName: "auth.passkey",
    disableMigration: true,
    fields: {
      credentialID: {
        type: "string",
        fieldName: "credentialID",
        required: true,
        index: true,
        unique: true,
      },
      counter: {
        type: "number",
        fieldName: "counter",
        required: true,
        bigint: true,
        transform: {
          input: passkeyCounterToDatabase,
          output: passkeyCounterFromDatabase,
        },
      },
    },
  },
  passkeySessionMarker: {
    modelName: "app.auth_passkey_session_marker",
    disableMigration: true,
    fields: {
      sessionId: {
        ...requiredField("string", "session_id"),
        unique: true,
        references: {
          model: "session",
          field: "id",
          onDelete: "cascade" as const,
        },
      },
      passkeyId: {
        type: "string",
        fieldName: "passkey_id",
        required: false,
        input: false,
        returned: false,
        references: {
          model: "passkey",
          field: "id",
          onDelete: "set null" as const,
        },
      },
      userVerified: requiredField("boolean", "user_verified"),
      credentialDeviceType: requiredField(
        "string",
        "credential_device_type",
      ),
      credentialBackedUp: requiredField(
        "boolean",
        "credential_backed_up",
      ),
      authenticatedAt: requiredField("date", "authenticated_at"),
      aaguid: {
        type: "string",
        fieldName: "aaguid",
        required: false,
        input: false,
        returned: false,
      },
      transports: {
        type: "string",
        fieldName: "transports",
        required: false,
        input: false,
        returned: false,
      },
    },
  },
} satisfies NonNullable<BetterAuthPlugin["schema"]>;

export const deltaPasskeySchemaOverlayPlugin = {
  id: "delta-passkey-schema-overlay",
  schema: deltaPasskeySchema,
} satisfies BetterAuthPlugin;
