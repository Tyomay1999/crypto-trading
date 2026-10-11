import {
  absExact,
  addExact,
  compareExact,
  divideExact,
  multiplyExact,
  parseExactDecimal,
  subtractExact,
  type ExactDecimal,
} from "../planning/decimal.js";
import type { PositionDirection } from "./types.js";

const SCALE = 10;

export function canonicalPositive(value: string, field: string): ExactDecimal {
  const parsed = parseExactDecimal(value);
  if (parsed.numerator <= 0n) {
    throw new RangeError(`${field} must be positive`);
  }
  return parsed;
}

export function canonicalNonNegative(value: string, field: string): ExactDecimal {
  const parsed = parseExactDecimal(value);
  if (parsed.numerator < 0n) {
    throw new RangeError(`${field} must be non-negative`);
  }
  return parsed;
}

export function canonicalFraction(value: string, field: string): ExactDecimal {
  const parsed = canonicalNonNegative(value, field);
  const one = parseExactDecimal("1");
  if (compareExact(parsed, one) > 0) {
    throw new RangeError(`${field} must be <= 1`);
  }
  return parsed;
}

export function canonicalSequence(value: string, field: string): bigint {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new TypeError(`${field} must be canonical non-negative integer text`);
  }
  return BigInt(value);
}

export function formatSigned(value: ExactDecimal, scale = SCALE): string {
  if (!Number.isInteger(scale) || scale < 0 || scale > 18) {
    throw new RangeError("scale out of range");
  }

  const negative = value.numerator < 0n;
  const numerator = negative ? -value.numerator : value.numerator;
  const factor = 10n ** BigInt(scale);
  const units = (numerator * factor) / value.denominator;

  if (units === 0n) {
    return "0";
  }

  const integerPart = units / factor;
  if (scale === 0) {
    return `${negative ? "-" : ""}${integerPart}`;
  }

  const fraction = (units % factor)
    .toString()
    .padStart(scale, "0")
    .replace(/0+$/u, "");

  const unsigned =
    fraction.length === 0 ? integerPart.toString() : `${integerPart}.${fraction}`;
  return negative ? `-${unsigned}` : unsigned;
}

export function quantityFromNotional(
  notionalText: string,
  entryText: string,
): ExactDecimal {
  return divideExact(
    canonicalPositive(notionalText, "initialNotional"),
    canonicalPositive(entryText, "actualEntryPrice"),
  );
}

export function pnlForFraction(input: {
  direction: PositionDirection;
  initialQuantity: string;
  fraction: string;
  entryPrice: string;
  exitPrice: string;
}): ExactDecimal {
  const quantity = canonicalPositive(input.initialQuantity, "initialQuantity");
  const fraction = canonicalFraction(input.fraction, "fraction");
  const entry = canonicalPositive(input.entryPrice, "entryPrice");
  const exit = canonicalPositive(input.exitPrice, "exitPrice");

  const priceDelta =
    input.direction === "LONG"
      ? subtractExact(exit, entry)
      : subtractExact(entry, exit);

  return multiplyExact(multiplyExact(quantity, fraction), priceDelta);
}

export function addText(a: string, b: ExactDecimal): string {
  return formatSigned(addExact(parseExactDecimal(a), b));
}

export function subtractFractions(a: string, b: string): string {
  const result = subtractExact(
    canonicalFraction(a, "remainingFraction"),
    canonicalFraction(b, "allocationFraction"),
  );
  if (result.numerator < 0n) {
    throw new RangeError("allocation exceeds remaining position");
  }
  return formatSigned(result);
}

export function addFractions(a: string, b: string): string {
  const result = addExact(
    canonicalFraction(a, "realizedFraction"),
    canonicalFraction(b, "allocationFraction"),
  );
  const one = parseExactDecimal("1");
  if (compareExact(result, one) > 0) {
    throw new RangeError("realized fraction exceeds one");
  }
  return formatSigned(result);
}

export function comparePrices(a: string, b: string): number {
  return compareExact(
    canonicalPositive(a, "priceA"),
    canonicalPositive(b, "priceB"),
  );
}

export function absPriceDistance(a: string, b: string): ExactDecimal {
  return absExact(
    subtractExact(
      canonicalPositive(a, "priceA"),
      canonicalPositive(b, "priceB"),
    ),
  );
}
