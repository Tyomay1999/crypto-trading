import type { BetterAuthPlugin, DBTransactionAdapter } from "better-auth";

const CAPABILITY_KIND =
  "delta-internal-passkey-test-transaction-selector-v1" as const;
const SELECTOR_MODEL = "i6FaultSelectorBinding";
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const MAX_IDENTITY_LENGTH = 128;

const authenticationScenarios = new Set([
  "CC1_CONCURRENT_CHALLENGE_CONSUMPTION",
  "CAS2_CONCURRENT_COUNTER_CONFLICT",
  "FI_CHALLENGE_DELETE",
  "FI_COUNTER_UPDATE",
  "FI_SESSION_INSERT",
  "FI_MARKER_INSERT",
  "FI_COMMIT_DEFERRED",
]);
const registrationScenarios = new Set([
  "FI_CHALLENGE_DELETE",
  "FI_REGISTRATION_INSERT",
]);

export type PasskeyTestSelectorOperation =
  | "authentication"
  | "registration";

export type PasskeyTestTransactionSelector = Readonly<{
  version: 1;
  scenarioId: string;
  authorizationId: string;
  attemptId: string;
  fixtureId: string;
  operation: PasskeyTestSelectorOperation;
  targetVerificationIdentifier?: string;
  targetUserId?: string;
  targetPasskeyId?: string;
  barrierClass?: number;
  barrierKey?: number;
}>;

type SelectorResolver = (input: Readonly<{
  operation: PasskeyTestSelectorOperation;
  context: object;
}>) =>
  | null
  | PasskeyTestTransactionSelector
  | Promise<null | PasskeyTestTransactionSelector>;

export type PasskeyTestTransactionSelectorCapability = Readonly<{
  kind: typeof CAPABILITY_KIND;
  schema: NonNullable<BetterAuthPlugin["schema"]>;
  bind(input: Readonly<{
    adapter: DBTransactionAdapter;
    operation: PasskeyTestSelectorOperation;
    context: object;
  }>): Promise<"absent" | "bound">;
}>;

type BindingRecord = Readonly<{
  id: string;
  payload: string;
}>;

export class PasskeyTestSelectorBindingError extends Error {
  constructor() {
    super("Test transaction selector binding failed.");
    this.name = "PasskeyTestSelectorBindingError";
  }
}

export const passkeyTestTransactionSelectorSchema = {
  [SELECTOR_MODEL]: {
    modelName: "i6_fault.selector_bind",
    disableMigration: true,
    fields: {
      payload: {
        type: "string",
        fieldName: "payload",
        required: true,
      },
    },
  },
} satisfies NonNullable<BetterAuthPlugin["schema"]>;

function exactIdentity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value !== "" &&
    value === value.trim() &&
    value.length <= MAX_IDENTITY_LENGTH &&
    !CONTROL_CHARACTERS.test(value)
  );
}

function optionalIdentity(value: unknown): value is string | undefined {
  return value === undefined || exactIdentity(value);
}

function int32(value: unknown): value is number {
  return (
    Number.isInteger(value) &&
    Number(value) >= -2147483648 &&
    Number(value) <= 2147483647
  );
}

function validScenario(
  operation: PasskeyTestSelectorOperation,
  scenarioId: string,
): boolean {
  return operation === "authentication"
    ? authenticationScenarios.has(scenarioId)
    : registrationScenarios.has(scenarioId);
}

function requiresBarrier(scenarioId: string): boolean {
  return (
    scenarioId === "CC1_CONCURRENT_CHALLENGE_CONSUMPTION" ||
    scenarioId === "CAS2_CONCURRENT_COUNTER_CONFLICT"
  );
}

function validateSelector(
  value: PasskeyTestTransactionSelector,
  operation: PasskeyTestSelectorOperation,
): PasskeyTestTransactionSelector {
  if (
    value.version !== 1 ||
    value.operation !== operation ||
    !exactIdentity(value.scenarioId) ||
    !validScenario(operation, value.scenarioId) ||
    !exactIdentity(value.authorizationId) ||
    !exactIdentity(value.attemptId) ||
    !exactIdentity(value.fixtureId) ||
    !optionalIdentity(value.targetVerificationIdentifier) ||
    !optionalIdentity(value.targetUserId) ||
    !optionalIdentity(value.targetPasskeyId)
  ) {
    throw new PasskeyTestSelectorBindingError();
  }

  const barrier = requiresBarrier(value.scenarioId);
  if (
    (barrier &&
      (!int32(value.barrierClass) || !int32(value.barrierKey))) ||
    (!barrier &&
      (value.barrierClass !== undefined || value.barrierKey !== undefined))
  ) {
    throw new PasskeyTestSelectorBindingError();
  }

  return Object.freeze({
    version: 1 as const,
    scenarioId: value.scenarioId,
    authorizationId: value.authorizationId,
    attemptId: value.attemptId,
    fixtureId: value.fixtureId,
    operation,
    ...(value.targetVerificationIdentifier === undefined
      ? {}
      : { targetVerificationIdentifier: value.targetVerificationIdentifier }),
    ...(value.targetUserId === undefined
      ? {}
      : { targetUserId: value.targetUserId }),
    ...(value.targetPasskeyId === undefined
      ? {}
      : { targetPasskeyId: value.targetPasskeyId }),
    ...(barrier
      ? {
          barrierClass: value.barrierClass,
          barrierKey: value.barrierKey,
        }
      : {}),
  });
}

export function createPasskeyTestTransactionSelectorCapability(
  resolve: SelectorResolver,
): PasskeyTestTransactionSelectorCapability {
  if (typeof resolve !== "function") {
    throw new PasskeyTestSelectorBindingError();
  }

  return Object.freeze({
    kind: CAPABILITY_KIND,
    schema: passkeyTestTransactionSelectorSchema,
    async bind(input) {
      if (
        !input ||
        typeof input.context !== "object" ||
        input.context === null ||
        (input.operation !== "authentication" &&
          input.operation !== "registration")
      ) {
        throw new PasskeyTestSelectorBindingError();
      }

      let selected: null | PasskeyTestTransactionSelector;
      try {
        selected = await resolve(
          Object.freeze({
            operation: input.operation,
            context: input.context,
          }),
        );
      } catch {
        throw new PasskeyTestSelectorBindingError();
      }
      if (selected === null) return "absent";

      const selector = validateSelector(selected, input.operation);
      const payload = JSON.stringify(selector);
      let bound: BindingRecord | null;
      try {
        bound = await input.adapter.create<BindingRecord, BindingRecord>({
          model: SELECTOR_MODEL,
          data: { payload },
          select: ["payload"],
        });
      } catch {
        throw new PasskeyTestSelectorBindingError();
      }
      if (!bound || bound.payload !== payload) {
        throw new PasskeyTestSelectorBindingError();
      }
      return "bound";
    },
  });
}
