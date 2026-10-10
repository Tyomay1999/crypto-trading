export const WEBAUTHN_COUNTER_MAX = 4_294_967_295;

const CANONICAL_UINT32_DECIMAL = /^(0|[1-9][0-9]{0,9})$/;

function invalidCounter(): never {
  throw new Error("Invalid WebAuthn signature counter.");
}

export function passkeyCounterFromDatabase(value: unknown): number {
  if (
    typeof value !== "string" ||
    !CANONICAL_UINT32_DECIMAL.test(value)
  ) {
    return invalidCounter();
  }

  const counter = Number(value);
  if (
    !Number.isSafeInteger(counter) ||
    counter < 0 ||
    counter > WEBAUTHN_COUNTER_MAX ||
    String(counter) !== value
  ) {
    return invalidCounter();
  }

  return counter;
}

export function passkeyCounterToDatabase(value: unknown): string {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > WEBAUTHN_COUNTER_MAX
  ) {
    return invalidCounter();
  }

  return String(value);
}
