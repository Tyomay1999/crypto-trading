import type {
  Pool,
  PoolClient,
} from "pg";

export const PASSKEY_MANAGEMENT_NAME_MAX_LENGTH =
  64 as const;

const IDENTITY_MAX_LENGTH = 256;
const CONTROL_CHARACTERS =
  /[\u0000-\u001f\u007f-\u009f]/;

type PasskeyManagementDatabase =
  Pick<Pool, "query" | "connect">;

type SafePasskeyRow = Readonly<{
  id: unknown;
  name: unknown;
  createdAt: unknown;
  deviceType: unknown;
  backedUp: unknown;
}>;

export type PasskeyManagementView =
  Readonly<{
    id: string;
    name: string | null;
    createdAt: Date;
    deviceType:
      | "singleDevice"
      | "multiDevice";
    backedUp: boolean;
  }>;

export type ListPasskeysResult =
  | Readonly<{
      status: "listed";
      passkeys:
        readonly PasskeyManagementView[];
    }>
  | Readonly<{
      status: "invalid_request";
    }>
  | Readonly<{
      status: "unavailable";
    }>;

export type RenamePasskeyResult =
  | Readonly<{
      status: "renamed";
      passkey: PasskeyManagementView;
    }>
  | Readonly<{
      status: "not_found";
    }>
  | Readonly<{
      status: "invalid_request";
    }>
  | Readonly<{
      status: "unavailable";
    }>;

export type DeletePasskeyResult =
  | Readonly<{
      status: "deleted";
    }>
  | Readonly<{
      status: "not_found";
    }>
  | Readonly<{
      status:
        "last_login_method_required";
    }>
  | Readonly<{
      status: "invalid_request";
    }>
  | Readonly<{
      status: "unavailable";
    }>;

function validIdentifier(
  value: unknown,
): value is string {
  return (
    typeof value === "string" &&
    value !== "" &&
    value === value.trim() &&
    value.length <= IDENTITY_MAX_LENGTH &&
    !CONTROL_CHARACTERS.test(value)
  );
}

function validName(
  value: unknown,
): value is string {
  return (
    typeof value === "string" &&
    value !== "" &&
    value === value.trim() &&
    value.length <=
      PASSKEY_MANAGEMENT_NAME_MAX_LENGTH &&
    !CONTROL_CHARACTERS.test(value)
  );
}

function safePasskeyView(
  row: SafePasskeyRow,
): PasskeyManagementView | null {
  if (
    !validIdentifier(row.id) ||
    (
      row.name !== null &&
      !validName(row.name)
    ) ||
    !(row.createdAt instanceof Date) ||
    !Number.isFinite(
      row.createdAt.getTime(),
    ) ||
    (
      row.deviceType !==
        "singleDevice" &&
      row.deviceType !==
        "multiDevice"
    ) ||
    typeof row.backedUp !== "boolean"
  ) {
    return null;
  }

  return Object.freeze({
    id: row.id,
    name: row.name,
    createdAt: row.createdAt,
    deviceType: row.deviceType,
    backedUp: row.backedUp,
  });
}

function status<
  Value extends
    | "invalid_request"
    | "unavailable"
    | "not_found"
    | "last_login_method_required"
    | "deleted",
>(value: Value): Readonly<{
  status: Value;
}> {
  return Object.freeze({
    status: value,
  });
}

export async function listPasskeysForUser(
  database: Pick<
    PasskeyManagementDatabase,
    "query"
  >,
  userId: string,
): Promise<ListPasskeysResult> {
  if (!validIdentifier(userId)) {
    return status("invalid_request");
  }

  try {
    const result =
      await database.query<SafePasskeyRow>(
        `
          SELECT
            p."id" AS "id",
            p."name" AS "name",
            p."createdAt" AS "createdAt",
            p."deviceType" AS "deviceType",
            p."backedUp" AS "backedUp"
          FROM auth."passkey" AS p
          WHERE p."userId" = $1
          ORDER BY
            p."createdAt" ASC NULLS LAST,
            p."id" ASC
        `,
        [userId],
      );

    const passkeys =
      result.rows.map(safePasskeyView);
    if (
      passkeys.some(
        (passkey) => passkey === null,
      )
    ) {
      return status("unavailable");
    }

    return Object.freeze({
      status: "listed" as const,
      passkeys: Object.freeze(
        passkeys as PasskeyManagementView[],
      ),
    });
  } catch {
    return status("unavailable");
  }
}

export async function renameOwnedPasskey(
  database: Pick<
    PasskeyManagementDatabase,
    "query"
  >,
  input: Readonly<{
    userId: string;
    passkeyId: string;
    name: string;
  }>,
): Promise<RenamePasskeyResult> {
  if (
    !validIdentifier(input.userId) ||
    !validIdentifier(input.passkeyId) ||
    !validName(input.name)
  ) {
    return status("invalid_request");
  }

  try {
    const result =
      await database.query<SafePasskeyRow>(
        `
          UPDATE auth."passkey"
          SET "name" = $3
          WHERE
            "userId" = $1
            AND "id" = $2
          RETURNING
            "id" AS "id",
            "name" AS "name",
            "createdAt" AS "createdAt",
            "deviceType" AS "deviceType",
            "backedUp" AS "backedUp"
        `,
        [
          input.userId,
          input.passkeyId,
          input.name,
        ],
      );

    if (result.rowCount !== 1) {
      return status("not_found");
    }
    const passkey =
      safePasskeyView(result.rows[0]);
    if (!passkey) {
      return status("unavailable");
    }

    return Object.freeze({
      status: "renamed" as const,
      passkey,
    });
  } catch {
    return status("unavailable");
  }
}

type CurrentPrimaryLoginMethod =
  | "password"
  | "passkey";

/*
 * The delete decision consumes a set of usable primary methods rather
 * than hard-coding a passkey-count expression at the decision point.
 * A future OAuth block can extend the method union and inventory loader
 * without changing the serialized delete/guard algorithm.
 */
function usablePrimaryLoginMethods(
  usablePassword: boolean,
  otherOwnedPasskeys: number,
): ReadonlySet<CurrentPrimaryLoginMethod> {
  const methods =
    new Set<CurrentPrimaryLoginMethod>();
  if (usablePassword) {
    methods.add("password");
  }
  if (otherOwnedPasskeys > 0) {
    methods.add("passkey");
  }
  return methods;
}

async function rollback(
  client: PoolClient,
): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original finite failure classification.
  }
}

export async function deleteOwnedPasskeyWithLastLoginGuard(
  database: Pick<
    PasskeyManagementDatabase,
    "connect"
  >,
  input: Readonly<{
    userId: string;
    passkeyId: string;
  }>,
): Promise<DeletePasskeyResult> {
  if (
    !validIdentifier(input.userId) ||
    !validIdentifier(input.passkeyId)
  ) {
    return status("invalid_request");
  }

  let client: PoolClient;
  try {
    client = await database.connect();
  } catch {
    return status("unavailable");
  }

  let transactionOpen = false;
  try {
    await client.query("BEGIN");
    transactionOpen = true;

    const lockedUser =
      await client.query<{
        id: unknown;
        emailVerified: unknown;
      }>(
        `
          SELECT
            u."id" AS "id",
            u."emailVerified" AS "emailVerified"
          FROM auth."user" AS u
          WHERE u."id" = $1
          FOR UPDATE
        `,
        [input.userId],
      );

    if (lockedUser.rowCount !== 1) {
      await rollback(client);
      transactionOpen = false;
      return status("unavailable");
    }

    const target =
      await client.query<{ id: unknown }>(
        `
          SELECT p."id" AS "id"
          FROM auth."passkey" AS p
          WHERE
            p."userId" = $1
            AND p."id" = $2
          LIMIT 1
        `,
        [
          input.userId,
          input.passkeyId,
        ],
      );

    if (target.rowCount !== 1) {
      await rollback(client);
      transactionOpen = false;
      return status("not_found");
    }

    const password =
      await client.query<{
        usablePassword: unknown;
      }>(
        `
          SELECT EXISTS (
            SELECT 1
            FROM auth."account" AS a
            WHERE
              a."userId" = $1
              AND a."providerId" = 'credential'
              AND a."password" IS NOT NULL
              AND length(a."password") > 0
          ) AS "usablePassword"
        `,
        [input.userId],
      );

    const otherPasskeys =
      await client.query<{
        otherPasskeyCount: unknown;
      }>(
        `
          SELECT
            COUNT(*)::integer AS "otherPasskeyCount"
          FROM auth."passkey" AS p
          WHERE
            p."userId" = $1
            AND p."id" <> $2
        `,
        [
          input.userId,
          input.passkeyId,
        ],
      );

    const verified =
      lockedUser.rows[0]
        ?.emailVerified;
    const passwordAvailable =
      password.rows[0]
        ?.usablePassword;
    const otherCount =
      otherPasskeys.rows[0]
        ?.otherPasskeyCount;
    if (
      typeof verified !== "boolean" ||
      typeof passwordAvailable !==
        "boolean" ||
      !Number.isInteger(otherCount) ||
      (otherCount as number) < 0
    ) {
      await rollback(client);
      transactionOpen = false;
      return status("unavailable");
    }

    const usableMethods =
      usablePrimaryLoginMethods(
        verified && passwordAvailable,
        otherCount as number,
      );
    if (usableMethods.size === 0) {
      await rollback(client);
      transactionOpen = false;
      return status(
        "last_login_method_required",
      );
    }

    const deleted =
      await client.query(
        `
          DELETE FROM auth."passkey"
          WHERE
            "userId" = $1
            AND "id" = $2
        `,
        [
          input.userId,
          input.passkeyId,
        ],
      );
    if (deleted.rowCount !== 1) {
      await rollback(client);
      transactionOpen = false;
      return status("not_found");
    }

    await client.query("COMMIT");
    transactionOpen = false;
    return status("deleted");
  } catch {
    if (transactionOpen) {
      await rollback(client);
    }
    return status("unavailable");
  } finally {
    client.release();
  }
}
