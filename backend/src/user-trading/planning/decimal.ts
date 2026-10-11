export interface ExactDecimal {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

export type PositiveRounding = "DOWN" | "UP";

const CANONICAL_DECIMAL = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u;

function absBigInt(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function gcd(aInput: bigint, bInput: bigint): bigint {
  let a = absBigInt(aInput);
  let b = absBigInt(bInput);

  while (b !== 0n) {
    const next = a % b;
    a = b;
    b = next;
  }

  return a === 0n ? 1n : a;
}

function normalize(numerator: bigint, denominator: bigint): ExactDecimal {
  if (denominator === 0n) {
    throw new RangeError("division by zero");
  }

  const sign = denominator < 0n ? -1n : 1n;
  const signedNumerator = numerator * sign;
  const positiveDenominator = denominator * sign;
  const divisor = gcd(signedNumerator, positiveDenominator);

  return {
    numerator: signedNumerator / divisor,
    denominator: positiveDenominator / divisor,
  };
}

export function parseExactDecimal(value: string): ExactDecimal {
  if (!CANONICAL_DECIMAL.test(value)) {
    throw new TypeError("value must be a canonical decimal string");
  }

  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [integerPart, fractionPart = ""] = unsigned.split(".");
  const denominator = 10n ** BigInt(fractionPart.length);
  const numerator =
    BigInt(integerPart) * denominator +
    BigInt(fractionPart.length === 0 ? "0" : fractionPart);

  return normalize(negative ? -numerator : numerator, denominator);
}

export function compareExact(a: ExactDecimal, b: ExactDecimal): number {
  const left = a.numerator * b.denominator;
  const right = b.numerator * a.denominator;
  return left < right ? -1 : left > right ? 1 : 0;
}

export function addExact(a: ExactDecimal, b: ExactDecimal): ExactDecimal {
  return normalize(
    a.numerator * b.denominator + b.numerator * a.denominator,
    a.denominator * b.denominator,
  );
}

export function subtractExact(a: ExactDecimal, b: ExactDecimal): ExactDecimal {
  return normalize(
    a.numerator * b.denominator - b.numerator * a.denominator,
    a.denominator * b.denominator,
  );
}

export function multiplyExact(a: ExactDecimal, b: ExactDecimal): ExactDecimal {
  return normalize(a.numerator * b.numerator, a.denominator * b.denominator);
}

export function divideExact(a: ExactDecimal, b: ExactDecimal): ExactDecimal {
  if (b.numerator === 0n) {
    throw new RangeError("division by zero");
  }
  return normalize(a.numerator * b.denominator, a.denominator * b.numerator);
}

export function absExact(value: ExactDecimal): ExactDecimal {
  return normalize(absBigInt(value.numerator), value.denominator);
}

export function minExact(a: ExactDecimal, b: ExactDecimal): ExactDecimal {
  return compareExact(a, b) <= 0 ? a : b;
}

export function isPositive(value: ExactDecimal): boolean {
  return value.numerator > 0n;
}

export function isNonNegative(value: ExactDecimal): boolean {
  return value.numerator >= 0n;
}

export function ceilPositiveInteger(value: ExactDecimal): bigint {
  if (value.numerator <= 0n) {
    throw new RangeError("ceilPositiveInteger requires a positive value");
  }
  return (value.numerator + value.denominator - 1n) / value.denominator;
}

export function formatPositiveDecimal(
  value: ExactDecimal,
  scale: number,
  rounding: PositiveRounding,
): string {
  if (!Number.isInteger(scale) || scale < 0 || scale > 18) {
    throw new RangeError("scale must be an integer from 0 to 18");
  }
  if (!isNonNegative(value)) {
    throw new RangeError("formatPositiveDecimal requires a non-negative value");
  }

  const factor = 10n ** BigInt(scale);
  const scaledNumerator = value.numerator * factor;
  let units = scaledNumerator / value.denominator;
  const remainder = scaledNumerator % value.denominator;

  if (rounding === "UP" && remainder !== 0n) {
    units += 1n;
  }

  if (scale === 0) {
    return units.toString();
  }

  const integerPart = units / factor;
  const fractionUnits = units % factor;
  const fraction = fractionUnits
    .toString()
    .padStart(scale, "0")
    .replace(/0+$/u, "");

  return fraction.length === 0
    ? integerPart.toString()
    : `${integerPart}.${fraction}`;
}
